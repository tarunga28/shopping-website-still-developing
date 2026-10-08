"""Tests for the ctypes binding to the native ranking engine.

These run against the real `libcppsearch.so`. They exist because a ctypes
boundary fails in ways Python tests do not normally catch: a wrong restype
silently truncates a pointer, a missing argtypes declaration promotes arguments,
and a struct field order mismatch produces plausible-looking garbage.
"""

from __future__ import annotations

import ctypes

import pytest

from app.ranking import (
    Document,
    RankingEngine,
    RankingEngineUnavailable,
    SearchOptions,
    load_engine,
)


def test_engine_loads_and_reports_a_version(engine: RankingEngine) -> None:
    version = engine.version
    assert version
    assert version[0].isdigit(), f"expected a semver-ish version, got {version!r}"


def test_upsert_and_count(engine: RankingEngine) -> None:
    engine.clear()
    assert engine.document_count == 0

    engine.upsert(Document(id="a", name="Cotton Tee"))
    engine.upsert(Document(id="b", name="Linen Shirt"))
    assert engine.document_count == 2
    assert engine.vocabulary_size > 0


def test_upsert_rejects_a_blank_id(engine: RankingEngine) -> None:
    # The C layer returns -2 for a blank id; the binding must surface it rather
    # than report success for a document it never stored.
    with pytest.raises(ValueError):
        engine.upsert(Document(id="", name="No id"))


def test_replacing_a_document_does_not_duplicate_it(engine: RankingEngine) -> None:
    engine.clear()
    engine.upsert(Document(id="a", name="iPhone 17"))
    engine.upsert(Document(id="a", name="iPhone 18"))

    assert engine.document_count == 1
    assert engine.search("17") == []
    assert [hit.id for hit in engine.search("18")] == ["a"]


def test_remove_reports_whether_the_document_existed(engine: RankingEngine) -> None:
    engine.clear()
    engine.upsert(Document(id="a", name="Cotton Tee"))
    assert engine.remove("a") is True
    assert engine.remove("a") is False


def test_search_ranks_the_closer_name_match_first(populated_engine: RankingEngine) -> None:
    # The accessory mentions "iPhone 17" too; the phone is the better answer to
    # a query that names the phone's distinguishing features.
    hits = populated_engine.search("iPhone 17 Pro Max 256GB")
    assert hits
    assert hits[0].id == "p-phone"


def test_search_matches_on_a_partial_word(populated_engine: RankingEngine) -> None:
    hits = populated_engine.search("ipho")
    assert {hit.id for hit in hits} >= {"p-phone", "p-case"}


def test_search_recovers_from_a_transposed_typo(populated_engine: RankingEngine) -> None:
    # "ipohne" is one transposition from "iphone", which both the phone and its
    # case contain — so the assertion is that the typo is recovered and flagged,
    # not which of the two ranks first.
    hits = populated_engine.search("ipohne")
    assert {hit.id for hit in hits} >= {"p-phone", "p-case"}
    assert all(hit.fuzzy for hit in hits)


def test_search_recovers_a_typo_no_exact_term_could_match(
    populated_engine: RankingEngine,
) -> None:
    # "silikone" matches nothing lexically at all; only fuzzy expansion can find
    # the case, which proves the path is doing real work.
    hits = populated_engine.search("silikone")
    assert [hit.id for hit in hits] == ["p-case"]
    assert hits[0].fuzzy is True


def test_search_does_not_fuzz_short_terms_into_nonsense(
    populated_engine: RankingEngine,
) -> None:
    # "mu" must not be corrected to "mug": two-letter guesses are wrong far more
    # often than they are right.
    options = SearchOptions(prefix_last_term=False)
    assert populated_engine.search("mu", options) == []


def test_search_ands_terms_together(populated_engine: RankingEngine) -> None:
    # Prefix expansion off, so "pro" cannot match the case's "protective" tag.
    # Both products mention iPhone; only the phone is a Pro.
    options = SearchOptions(prefix_last_term=False)
    hits = populated_engine.search("iphone pro", options)
    assert [hit.id for hit in hits] == ["p-phone"]


def test_prefix_expansion_deliberately_widens_the_last_term(
    populated_engine: RankingEngine,
) -> None:
    # The flip side of the test above, and the behaviour a live search box wants:
    # "pro" is mid-word, so the case tagged "protective" is a legitimate hit.
    hits = populated_engine.search("iphone pro")
    assert {hit.id for hit in hits} == {"p-phone", "p-case"}
    case = next(hit for hit in hits if hit.id == "p-case")
    assert "tags" in case.matched_fields


def test_search_reports_which_fields_matched(populated_engine: RankingEngine) -> None:
    hits = populated_engine.search("apple")
    assert hits
    assert "brand" in hits[0].matched_fields


def test_search_finds_attribute_values(populated_engine: RankingEngine) -> None:
    # "256gb" is not in the phone's name as a standalone term everywhere, but it
    # is an attribute value and must be findable.
    hits = populated_engine.search("256gb")
    assert [hit.id for hit in hits] == ["p-phone"]


def test_search_limit_is_respected(populated_engine: RankingEngine) -> None:
    options = SearchOptions(limit=2)
    assert len(populated_engine.search("inkline", options)) <= 2


def test_search_options_validation_rejects_nonsense() -> None:
    with pytest.raises(ValueError):
        SearchOptions(limit=0).validate()
    with pytest.raises(ValueError):
        SearchOptions(limit=5000).validate()
    with pytest.raises(ValueError):
        # Beyond three edits the "correction" no longer resembles the query.
        SearchOptions(max_edit_distance=4).validate()
    with pytest.raises(ValueError):
        SearchOptions(popularity_weight=-1.0).validate()


def test_complete_prefix(populated_engine: RankingEngine) -> None:
    terms = populated_engine.complete("iph")
    assert terms
    assert all(term.startswith("iph") for term in terms)


def test_match_attribute_is_exact(populated_engine: RankingEngine) -> None:
    assert populated_engine.match_attribute("brand", "apple") == []
    # The sample rows carry attribute_pairs only when set; verify the negative
    # path and the positive one on a document built for it.
    populated_engine.upsert(
        Document(id="p-extra", name="Extra Phone", attribute_pairs={"storage": "512gb"})
    )
    assert populated_engine.match_attribute("storage", "512gb") == ["p-extra"]
    assert populated_engine.match_attribute("storage", "1tb") == []


def test_fuzzy_match_attribute_tolerates_a_typo(populated_engine: RankingEngine) -> None:
    populated_engine.upsert(
        Document(id="p-extra", name="Extra Phone", attribute_pairs={"storage": "512gb"})
    )
    assert populated_engine.fuzzy_match_attribute("storage", "512gbe", 0.6) == ["p-extra"]


def test_tokenize_matches_the_typescript_rules(engine: RankingEngine) -> None:
    assert engine.tokenize("iPhone 17 Pro-Max 256GB") == [
        "iphone",
        "17",
        "pro",
        "max",
        "256gb",
    ]
    # Diacritics fold, so an accented product name is found by its plain spelling.
    assert engine.tokenize("café") == ["cafe"]


def test_canonical_query_is_order_insensitive(engine: RankingEngine) -> None:
    assert engine.canonical_query("Case iPhone case") == "case iphone"
    assert engine.canonical_query("iphone case") == "case iphone"


def test_edit_distance_counts_a_transposition_as_one(engine: RankingEngine) -> None:
    assert engine.edit_distance("iphone", "ipohne") == 1


def test_word_similarity_beats_whole_string_similarity(engine: RankingEngine) -> None:
    haystack = "premium silicone phone case"
    assert engine.word_similarity("silicone", haystack) > 0.9
    # A short needle against a long haystack must not score near zero, which is
    # exactly what a whole-string similarity function would return.
    assert engine.word_similarity("silikone", haystack) > 0.4


def test_unicode_survives_the_round_trip(engine: RankingEngine) -> None:
    """Non-Latin text indexes and matches in its own script.

    Note what this does NOT claim: the tokenizer folds diacritics and case, it
    does not transliterate. "हिंदी" is not findable by typing "hindi" — that
    would need a transliteration table, which is a separate feature.
    """
    engine.clear()
    engine.upsert(Document(id="u", name="हिंदी Cotton Té"))
    assert [hit.id for hit in engine.search("हिंदी")] == ["u"]
    assert engine.tokenize("हिंदी Cotton Té") == ["हिंदी", "cotton", "te"]
    # "Té" folds to "te", so the accented spelling is found by its plain one.
    assert [hit.id for hit in engine.search("te")] == ["u"]


def test_closing_the_engine_makes_further_calls_raise(engine: RankingEngine) -> None:
    # Uses a throwaway engine: the session fixture is shared.
    temporary = load_engine()
    temporary.upsert(Document(id="a", name="Cotton Tee"))
    temporary.close()
    with pytest.raises(RankingEngineUnavailable):
        temporary.search("tee")


def test_double_close_is_safe() -> None:
    temporary = load_engine()
    temporary.close()
    temporary.close()  # must not crash the process


def test_missing_library_reports_every_path_tried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CPPSEARCH_LIBRARY", "/nonexistent/libcppsearch.so")
    monkeypatch.setattr("app.ranking._repo_root", lambda: __import__("pathlib").Path("/nonexistent"))
    with pytest.raises(RankingEngineUnavailable) as excinfo:
        load_engine()
    # The message must name what was tried, or a deployment problem is not
    # diagnosable from the log alone.
    assert "make -C native/cpp-search" in str(excinfo.value)


def test_struct_layout_matches_the_c_header() -> None:
    """Guard against the ctypes structs drifting from include/cppsearch/ffi.h.

    A field-order mistake does not raise; it produces garbage. Pinning the sizes
    and the order of the first few fields catches a reorder at test time.
    """
    from app.ranking import _CDocument, _CHit, _CSearchOptions

    document_names = [name for name, _ in _CDocument._fields_]
    assert document_names[:8] == [
        "id",
        "name",
        "brand",
        "category_path",
        "tags",
        "attributes",
        "skus",
        "description",
    ]
    assert document_names[-4:] == [
        "price_minor_units",
        "popularity",
        "rating",
        "rating_count",
    ]

    assert [name for name, _ in _CSearchOptions._fields_] == [
        "prefix_last_term",
        "max_edit_distance",
        "min_fuzzy_length",
        "limit",
        "popularity_weight",
        "rating_weight",
    ]
    assert [name for name, _ in _CHit._fields_] == [
        "id",
        "score",
        "matched_fields",
        "fuzzy",
    ]

    # A pointer field is 8 bytes on x86-64; if this ever fails, the struct
    # alignment assumption behind the whole binding is wrong.
    assert ctypes.sizeof(ctypes.c_void_p) == 8
