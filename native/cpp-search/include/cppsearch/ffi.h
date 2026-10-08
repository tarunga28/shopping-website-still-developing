#pragma once
// C ABI for the cpp-search ranking engine.
//
// This is the ONLY surface other languages are allowed to touch. The C++
// classes use std::string and std::vector, which have no stable layout across
// compilers — so every export here takes and returns plain C types, and all
// memory the engine allocates is freed by the engine.
//
// Thread safety: an index handle may be read concurrently (search, complete,
// match) but must not be mutated while a read is in flight. The service layer
// owns a read-write lock around upsert/remove.
//
// Consumed from Python via ctypes; see services/catalog-service/app/ranking.py.

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define CPPSEARCH_API __declspec(dllexport)
#else
#define CPPSEARCH_API __attribute__((visibility("default")))
#endif

/** Opaque handle to a SearchIndex. */
typedef struct cppsearch_index cppsearch_index;

/** One searchable document. All strings are UTF-8; NULL is treated as empty. */
typedef struct cppsearch_document {
  const char* id;
  const char* name;
  const char* brand;
  const char* category_path;
  const char* tags;
  const char* attributes;
  const char* skus;
  const char* description;
  /** Parallel arrays of attribute key/value pairs. */
  const char* const* attribute_keys;
  const char* const* attribute_values;
  size_t attribute_count;
  int64_t price_minor_units;
  double popularity;
  double rating;
  int32_t rating_count;
} cppsearch_document;

typedef struct cppsearch_search_options {
  int prefix_last_term;      /* boolean */
  size_t max_edit_distance;  /* fuzzy ceiling */
  size_t min_fuzzy_length;   /* shortest term eligible for fuzzy expansion */
  size_t limit;
  double popularity_weight;
  double rating_weight;
} cppsearch_search_options;

typedef struct cppsearch_hit {
  const char* id;
  double score;
  uint8_t matched_fields;  /* bitmask of fields that contributed */
  int fuzzy;               /* boolean: at least one term matched fuzzily */
} cppsearch_hit;

/** Library version, for the service to log at startup. */
CPPSEARCH_API const char* cppsearch_version(void);

/** Create an empty index. Returns NULL on allocation failure. */
CPPSEARCH_API cppsearch_index* cppsearch_index_create(void);

/** Destroy an index and free everything it owns. */
CPPSEARCH_API void cppsearch_index_destroy(cppsearch_index* index);

/** Add or replace a document. Returns 0 on success, non-zero on invalid input. */
CPPSEARCH_API int cppsearch_index_upsert(cppsearch_index* index, const cppsearch_document* document);

/** Remove a document. Returns 1 if it existed, 0 otherwise. */
CPPSEARCH_API int cppsearch_index_remove(cppsearch_index* index, const char* id);

/** Number of indexed documents. */
CPPSEARCH_API size_t cppsearch_index_size(const cppsearch_index* index);

/** Number of distinct terms in the vocabulary. */
CPPSEARCH_API size_t cppsearch_index_vocabulary_size(const cppsearch_index* index);

/** Fill `options` with the defaults the engine would use. */
CPPSEARCH_API void cppsearch_default_options(cppsearch_search_options* options);

/**
 * Rank documents against a query.
 *
 * Returns the number of hits written to `out_hits`, which the CALLER allocates
 * with room for `capacity` entries. The returned `id` pointers remain valid
 * until the index is mutated or destroyed — copy them if you need them longer.
 * Returns -1 on invalid arguments.
 */
CPPSEARCH_API int cppsearch_index_search(const cppsearch_index* index, const char* query,
                                         const cppsearch_search_options* options,
                                         cppsearch_hit* out_hits, size_t capacity);

/**
 * Autocomplete terms.
 *
 * `out_terms` is an array of `capacity` `const char*` the caller allocates; the
 * engine fills it with pointers into its own vocabulary. Returns the count, or
 * -1 on invalid arguments.
 */
CPPSEARCH_API int cppsearch_index_complete(const cppsearch_index* index, const char* prefix,
                                           const char** out_terms, size_t capacity);

/** Document ids with exactly this attribute value. Returns count, or -1. */
CPPSEARCH_API int cppsearch_index_match_attribute(const cppsearch_index* index, const char* key,
                                                  const char* value, const char** out_ids,
                                                  size_t capacity);

/** Document ids with an attribute value close to `value`. Returns count, or -1. */
CPPSEARCH_API int cppsearch_index_fuzzy_match_attribute(const cppsearch_index* index,
                                                        const char* key, const char* value,
                                                        double min_similarity, const char** out_ids,
                                                        size_t capacity);

/* ── Standalone primitives, exposed so callers can reuse the same maths ── */

/** Edit distance with an optional ceiling. Pass 0 for max_distance to disable. */
CPPSEARCH_API size_t cppsearch_damerau_levenshtein(const char* a, const char* b, size_t max_distance);

/** Similarity in [0, 1]. */
CPPSEARCH_API double cppsearch_similarity(const char* a, const char* b);

/** Best similarity of `needle` against any word in `haystack`, in [0, 1]. */
CPPSEARCH_API double cppsearch_word_similarity(const char* needle, const char* haystack);

/**
 * Tokenize text.
 *
 * `out_tokens` is a caller-allocated array of `capacity` `const char*`; the
 * engine fills it with pointers into a buffer it owns, which stays valid until
 * the next call on the same thread. Returns the token count, or -1 on error.
 */
CPPSEARCH_API int cppsearch_tokenize(const char* text, const char** out_tokens, size_t capacity);

/**
 * Normalized, folded text.
 *
 * Returns the length written, or -1 if `text` does not fit in `capacity` bytes
 * (including the terminator). It never truncates: a shortened string returned
 * here would silently become the wrong cache key. `out` is left untouched on
 * failure, so the caller can retry with the length from a first attempt.
 */
CPPSEARCH_API int cppsearch_normalize(const char* text, char* out, size_t capacity);

/** Canonical query key: tokens deduplicated and sorted. Same contract as
 *  cppsearch_normalize — returns the length, or -1 if the buffer is too small. */
CPPSEARCH_API int cppsearch_canonical_query(const char* text, char* out, size_t capacity);

#ifdef __cplusplus
}
#endif
