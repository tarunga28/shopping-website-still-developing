"""ctypes binding to the cpp-search ranking engine.

This is the service boundary the product spec calls for: the TypeScript app owns
catalog CRUD and persistence, while ranking lives in the native engine. Nothing
outside this module is allowed to touch `libcppsearch.so`.

Two design points worth keeping:

1. **Fail open, loudly.** If the shared library is missing or an ABI call fails,
   the wrapper raises `RankingEngineUnavailable`. The API layer turns that into
   a 503 rather than silently returning empty results — an empty search page is
   indistinguishable from a catalog with nothing in it, which is a much worse
   failure than an explicit error.

2. **Copy across the boundary immediately.** The C API returns pointers into a
   thread-local arena that is reset on the next call, so every string is copied
   into a Python object before the next call can invalidate it.
"""

from __future__ import annotations

import ctypes
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

__all__ = [
    "RankingEngineUnavailable",
    "Document",
    "SearchHit",
    "SearchOptions",
    "RankingEngine",
    "load_engine",
]


class RankingEngineUnavailable(RuntimeError):
    """The native ranking engine could not be loaded or refused a call."""


# ── C structure mirrors of include/cppsearch/ffi.h ────────────────────────
#
# These must stay field-for-field identical to the C headers. `_pack_` is not
# set, so the default platform alignment is used on both sides.


class _CDocument(ctypes.Structure):
    _fields_ = [
        ("id", ctypes.c_char_p),
        ("name", ctypes.c_char_p),
        ("brand", ctypes.c_char_p),
        ("category_path", ctypes.c_char_p),
        ("tags", ctypes.c_char_p),
        ("attributes", ctypes.c_char_p),
        ("skus", ctypes.c_char_p),
        ("description", ctypes.c_char_p),
        ("attribute_keys", ctypes.POINTER(ctypes.c_char_p)),
        ("attribute_values", ctypes.POINTER(ctypes.c_char_p)),
        ("attribute_count", ctypes.c_size_t),
        ("price_minor_units", ctypes.c_int64),
        ("popularity", ctypes.c_double),
        ("rating", ctypes.c_double),
        ("rating_count", ctypes.c_int32),
    ]


class _CSearchOptions(ctypes.Structure):
    _fields_ = [
        ("prefix_last_term", ctypes.c_int),
        ("max_edit_distance", ctypes.c_size_t),
        ("min_fuzzy_length", ctypes.c_size_t),
        ("limit", ctypes.c_size_t),
        ("popularity_weight", ctypes.c_double),
        ("rating_weight", ctypes.c_double),
    ]


class _CHit(ctypes.Structure):
    _fields_ = [
        ("id", ctypes.c_char_p),
        ("score", ctypes.c_double),
        ("matched_fields", ctypes.c_uint8),
        ("fuzzy", ctypes.c_int),
    ]


# Field bits, matching enum class Field in include/cppsearch/index.h.
FIELD_NAMES: tuple[str, ...] = (
    "name",
    "brand",
    "category",
    "tags",
    "attributes",
    "sku",
    "description",
)


def _encode(value: str | None) -> bytes:
    return (value or "").encode("utf-8")


@dataclass(slots=True)
class Document:
    """One searchable product, in the shape the engine expects."""

    id: str
    name: str = ""
    brand: str = ""
    category_path: str = ""
    tags: str = ""
    attributes: str = ""
    skus: str = ""
    description: str = ""
    attribute_pairs: dict[str, str] = field(default_factory=dict)
    price_minor_units: int = 0
    popularity: float = 0.0
    rating: float = 0.0
    rating_count: int = 0


@dataclass(slots=True)
class SearchOptions:
    """Search tuning knobs. The defaults match the C++ `SearchOptions`."""

    prefix_last_term: bool = True
    max_edit_distance: int = 1
    min_fuzzy_length: int = 4
    limit: int = 20
    popularity_weight: float = 0.001
    rating_weight: float = 0.01

    def validate(self) -> None:
        """Reject values that would make the engine do something unintended."""
        if self.limit <= 0 or self.limit > 1000:
            raise ValueError("limit must be between 1 and 1000")
        if self.max_edit_distance > 3:
            # Beyond three edits, "corrections" stop resembling the query and
            # start matching unrelated products.
            raise ValueError("max_edit_distance must not exceed 3")
        if self.popularity_weight < 0 or self.rating_weight < 0:
            raise ValueError("weights must not be negative")


@dataclass(slots=True, frozen=True)
class SearchHit:
    """One ranked result."""

    id: str
    score: float
    matched_fields: tuple[str, ...]
    fuzzy: bool

    @staticmethod
    def _decode_fields(bits: int) -> tuple[str, ...]:
        return tuple(
            name for index, name in enumerate(FIELD_NAMES) if bits & (1 << index)
        )


class RankingEngine:
    """Owns one native index and serialises access to it.

    The C API allows concurrent reads but not concurrent mutation, so writes
    take a write lock and reads take the same lock. A real deployment would use
    a read-write lock and double-buffered indexes; a plain lock is correct here
    and the index rebuild is fast enough that contention does not matter at the
    volumes this service handles.
    """

    def __init__(self, library: ctypes.CDLL) -> None:
        self._lib = library
        self._lock = threading.RLock()
        self._configure_signatures()
        self._index = library.cppsearch_index_create()
        if not self._index:
            raise RankingEngineUnavailable("cppsearch_index_create returned NULL")
        self._documents = 0

    # ── lifecycle ────────────────────────────────────────────────────────

    def _configure_signatures(self) -> None:
        """Declare argument and return types.

        ctypes defaults every return type to `c_int`, which silently truncates
        the 64-bit pointer returned by `cppsearch_index_create` on x86-64. These
        declarations are what keep the handle intact.
        """
        lib = self._lib

        lib.cppsearch_version.restype = ctypes.c_char_p
        lib.cppsearch_version.argtypes = []

        lib.cppsearch_index_create.restype = ctypes.c_void_p
        lib.cppsearch_index_create.argtypes = []

        lib.cppsearch_index_destroy.restype = None
        lib.cppsearch_index_destroy.argtypes = [ctypes.c_void_p]

        lib.cppsearch_index_upsert.restype = ctypes.c_int
        lib.cppsearch_index_upsert.argtypes = [ctypes.c_void_p, ctypes.POINTER(_CDocument)]

        lib.cppsearch_index_remove.restype = ctypes.c_int
        lib.cppsearch_index_remove.argtypes = [ctypes.c_void_p, ctypes.c_char_p]

        lib.cppsearch_index_size.restype = ctypes.c_size_t
        lib.cppsearch_index_size.argtypes = [ctypes.c_void_p]

        lib.cppsearch_index_vocabulary_size.restype = ctypes.c_size_t
        lib.cppsearch_index_vocabulary_size.argtypes = [ctypes.c_void_p]

        lib.cppsearch_default_options.restype = None
        lib.cppsearch_default_options.argtypes = [ctypes.POINTER(_CSearchOptions)]

        lib.cppsearch_index_search.restype = ctypes.c_int
        lib.cppsearch_index_search.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(_CSearchOptions),
            ctypes.POINTER(_CHit),
            ctypes.c_size_t,
        ]

        lib.cppsearch_index_complete.restype = ctypes.c_int
        lib.cppsearch_index_complete.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_size_t,
        ]

        lib.cppsearch_index_match_attribute.restype = ctypes.c_int
        lib.cppsearch_index_match_attribute.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_size_t,
        ]

        lib.cppsearch_index_fuzzy_match_attribute.restype = ctypes.c_int
        lib.cppsearch_index_fuzzy_match_attribute.argtypes = [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_double,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_size_t,
        ]

        lib.cppsearch_damerau_levenshtein.restype = ctypes.c_size_t
        lib.cppsearch_damerau_levenshtein.argtypes = [
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_size_t,
        ]

        lib.cppsearch_similarity.restype = ctypes.c_double
        lib.cppsearch_similarity.argtypes = [ctypes.c_char_p, ctypes.c_char_p]

        lib.cppsearch_word_similarity.restype = ctypes.c_double
        lib.cppsearch_word_similarity.argtypes = [ctypes.c_char_p, ctypes.c_char_p]

        lib.cppsearch_tokenize.restype = ctypes.c_int
        lib.cppsearch_tokenize.argtypes = [
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_size_t,
        ]

        lib.cppsearch_canonical_query.restype = ctypes.c_int
        lib.cppsearch_canonical_query.argtypes = [
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_size_t,
        ]

    def close(self) -> None:
        with self._lock:
            if self._index:
                self._lib.cppsearch_index_destroy(self._index)
                self._index = None

    def __enter__(self) -> "RankingEngine":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── introspection ────────────────────────────────────────────────────

    @property
    def version(self) -> str:
        return (self._lib.cppsearch_version() or b"").decode("utf-8")

    @property
    def document_count(self) -> int:
        with self._lock:
            self._require_open()
            return int(self._lib.cppsearch_index_size(self._index))

    @property
    def vocabulary_size(self) -> int:
        with self._lock:
            self._require_open()
            return int(self._lib.cppsearch_index_vocabulary_size(self._index))

    def _require_open(self) -> None:
        if not self._index:
            raise RankingEngineUnavailable("the ranking engine has been closed")

    # ── mutation ─────────────────────────────────────────────────────────

    def upsert(self, document: Document) -> None:
        if not document.id:
            raise ValueError("a document must have an id")

        keys = [_encode(key) for key in document.attribute_pairs]
        values = [_encode(value) for value in document.attribute_pairs.values()]
        key_array = (ctypes.c_char_p * len(keys))(*keys) if keys else None
        value_array = (ctypes.c_char_p * len(values))(*values) if values else None

        payload = _CDocument(
            id=_encode(document.id),
            name=_encode(document.name),
            brand=_encode(document.brand),
            category_path=_encode(document.category_path),
            tags=_encode(document.tags),
            attributes=_encode(document.attributes),
            skus=_encode(document.skus),
            description=_encode(document.description),
            attribute_keys=key_array,
            attribute_values=value_array,
            attribute_count=len(keys),
            price_minor_units=document.price_minor_units,
            popularity=document.popularity,
            rating=document.rating,
            rating_count=document.rating_count,
        )

        with self._lock:
            self._require_open()
            # `payload` and the arrays must stay alive for the duration of the
            # call, so they are referenced here rather than built inline.
            result = self._lib.cppsearch_index_upsert(self._index, ctypes.byref(payload))
        if result != 0:
            raise RankingEngineUnavailable(f"cppsearch_index_upsert failed with {result}")

    def upsert_many(self, documents: Iterable[Document]) -> int:
        count = 0
        for document in documents:
            self.upsert(document)
            count += 1
        return count

    def remove(self, document_id: str) -> bool:
        with self._lock:
            self._require_open()
            return bool(self._lib.cppsearch_index_remove(self._index, _encode(document_id)))

    def clear(self) -> None:
        """Replace the index with an empty one.

        There is no `clear` in the C ABI, so a fresh index is swapped in under
        the lock. Doing it this way also guarantees a partially built index is
        never visible to readers.
        """
        with self._lock:
            self._require_open()
            fresh = self._lib.cppsearch_index_create()
            if not fresh:
                raise RankingEngineUnavailable("cppsearch_index_create returned NULL")
            self._lib.cppsearch_index_destroy(self._index)
            self._index = fresh

    # ── queries ──────────────────────────────────────────────────────────

    def search(self, query: str, options: SearchOptions | None = None) -> list[SearchHit]:
        options = options or SearchOptions()
        options.validate()

        raw = _CSearchOptions(
            prefix_last_term=1 if options.prefix_last_term else 0,
            max_edit_distance=options.max_edit_distance,
            min_fuzzy_length=options.min_fuzzy_length,
            limit=options.limit,
            popularity_weight=options.popularity_weight,
            rating_weight=options.rating_weight,
        )
        hits = (_CHit * options.limit)()

        with self._lock:
            self._require_open()
            count = self._lib.cppsearch_index_search(
                self._index, _encode(query), ctypes.byref(raw), hits, options.limit
            )
            if count < 0:
                raise RankingEngineUnavailable(f"cppsearch_index_search failed with {count}")
            # Copy out before releasing the lock: the returned `id` pointers
            # belong to a thread-local arena the next call will reset.
            return [
                SearchHit(
                    id=(hits[index].id or b"").decode("utf-8"),
                    score=hits[index].score,
                    matched_fields=SearchHit._decode_fields(hits[index].matched_fields),
                    fuzzy=bool(hits[index].fuzzy),
                )
                for index in range(count)
            ]

    def complete(self, prefix: str, limit: int = 10) -> list[str]:
        if limit <= 0 or limit > 100:
            raise ValueError("limit must be between 1 and 100")
        terms = (ctypes.c_char_p * limit)()
        with self._lock:
            self._require_open()
            count = self._lib.cppsearch_index_complete(
                self._index, _encode(prefix), terms, limit
            )
            if count < 0:
                raise RankingEngineUnavailable(f"cppsearch_index_complete failed with {count}")
            return [(terms[index] or b"").decode("utf-8") for index in range(count)]

    def match_attribute(
        self, key: str, value: str, limit: int = 100
    ) -> list[str]:
        ids = (ctypes.c_char_p * limit)()
        with self._lock:
            self._require_open()
            count = self._lib.cppsearch_index_match_attribute(
                self._index, _encode(key), _encode(value), ids, limit
            )
            if count < 0:
                raise RankingEngineUnavailable(
                    f"cppsearch_index_match_attribute failed with {count}"
                )
            return [(ids[index] or b"").decode("utf-8") for index in range(count)]

    def fuzzy_match_attribute(
        self, key: str, value: str, min_similarity: float = 0.6, limit: int = 20
    ) -> list[str]:
        ids = (ctypes.c_char_p * limit)()
        with self._lock:
            self._require_open()
            count = self._lib.cppsearch_index_fuzzy_match_attribute(
                self._index, _encode(key), _encode(value), min_similarity, ids, limit
            )
            if count < 0:
                raise RankingEngineUnavailable(
                    f"cppsearch_index_fuzzy_match_attribute failed with {count}"
                )
            return [(ids[index] or b"").decode("utf-8") for index in range(count)]

    # ── standalone primitives ────────────────────────────────────────────

    def edit_distance(self, a: str, b: str, max_distance: int = 0) -> int:
        return int(
            self._lib.cppsearch_damerau_levenshtein(_encode(a), _encode(b), max_distance)
        )

    def similarity(self, a: str, b: str) -> float:
        return float(self._lib.cppsearch_similarity(_encode(a), _encode(b)))

    def word_similarity(self, needle: str, haystack: str) -> float:
        return float(self._lib.cppsearch_word_similarity(_encode(needle), _encode(haystack)))

    def tokenize(self, text: str, limit: int = 64) -> list[str]:
        tokens = (ctypes.c_char_p * limit)()
        count = self._lib.cppsearch_tokenize(_encode(text), tokens, limit)
        if count < 0:
            raise RankingEngineUnavailable(f"cppsearch_tokenize failed with {count}")
        return [(tokens[index] or b"").decode("utf-8") for index in range(count)]

    def canonical_query(self, text: str) -> str:
        buffer = ctypes.create_string_buffer(512)
        length = self._lib.cppsearch_canonical_query(_encode(text), buffer, 512)
        if length < 0:
            raise RankingEngineUnavailable(f"cppsearch_canonical_query failed with {length}")
        return buffer.value.decode("utf-8")


# ── loading ───────────────────────────────────────────────────────────────

# Searched in order, so an explicit configuration wins over a build output and a
# build output wins over something on the loader path.
_CANDIDATE_PATHS: tuple[str, ...] = (
    "native/cpp-search/build/libcppsearch.so",
    "native/cpp-search/build/libcppsearch.dylib",
)


def _repo_root() -> Path:
    # app/ranking.py -> app -> catalog-service -> services -> repo root
    return Path(__file__).resolve().parents[3]


def _candidate_paths(configured: str = "") -> list[Path]:
    """Paths to try, most specific first.

    `configured` comes from settings (`CATALOG_SERVICE_CPPSEARCH_LIBRARY`). The
    unprefixed `CPPSEARCH_LIBRARY` is still honoured because the repository-root
    `.env.example` documents it for the Next.js process; this function used to
    read only that one, which silently ignored the service's own prefixed
    setting.
    """
    paths: list[Path] = []
    for value in (configured, os.environ.get("CPPSEARCH_LIBRARY", "")):
        if value:
            paths.append(Path(value))
    root = _repo_root()
    paths.extend(root / relative for relative in _CANDIDATE_PATHS)
    # Fall back to the loader's own search path.
    paths.append(Path("libcppsearch.so"))
    return paths


def load_engine(configured_library: str = "") -> RankingEngine:
    """Load the native library and return a ready engine.

    `configured_library` is the operator-supplied path from settings. Callers
    that have settings should pass it; passing nothing still works and falls
    back to the environment and the usual in-repo locations.

    Raises `RankingEngineUnavailable` naming every path that was tried, so a
    deployment problem is diagnosable from one log line rather than requiring
    someone to read this function.
    """
    attempted: list[str] = []
    for candidate in _candidate_paths(configured_library):
        attempted.append(str(candidate))
        try:
            library = ctypes.CDLL(str(candidate))
        except OSError:
            continue
        return RankingEngine(library)

    raise RankingEngineUnavailable(
        "could not load libcppsearch; run `make -C native/cpp-search` first. Tried: "
        + ", ".join(attempted)
    )
