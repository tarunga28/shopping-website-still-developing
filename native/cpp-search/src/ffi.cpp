#include "cppsearch/ffi.h"

#include <algorithm>
#include <cstring>
#include <deque>
#include <new>
#include <string>

#include "cppsearch/index.h"
#include "cppsearch/similarity.h"
#include "cppsearch/tokenizer.h"

// The C ABI layer. Every function here is defensive: a NULL or invalid argument
// returns an error code rather than crashing the host process, because a ranking
// engine taking down a search service is a worse outcome than returning no hits.

namespace {

constexpr const char* kVersion = "1.0.0";

/**
 * Storage for strings handed back across the C boundary.
 *
 * `cppsearch_tokenize` and friends must return `const char*` values that stay
 * valid after the call. They live in a thread-local arena that is reset at the
 * start of each call, so the documented lifetime is "until the next call on the
 * same thread" — enough for ctypes to copy them immediately.
 */
struct StringArena {
  /**
   * A deque, deliberately not a vector.
   *
   * `Intern` hands out `c_str()` pointers that the C contract promises remain
   * valid until the next call. A vector would break that promise: growing it
   * moves the existing std::string objects, and for short strings the bytes
   * live inside the object (small-string optimisation), so every pointer handed
   * out so far would dangle. A deque never invalidates references to existing
   * elements, so the pointers stay good for the whole call.
   */
  std::deque<std::string> strings;

  const char* Intern(std::string value) {
    strings.push_back(std::move(value));
    return strings.back().c_str();
  }
};

thread_local StringArena g_arena;

const char* SafeString(const char* value) { return value == nullptr ? "" : value; }

/**
 * Copy `source` into `out`, refusing rather than truncating.
 *
 * Truncation would be worse than failure here: `cppsearch_canonical_query`
 * produces cache keys, and a silently shortened key would collide with a
 * different query. On failure `out` is left untouched and the FFI layer returns
 * -1, so the caller knows to retry with a larger buffer.
 */
bool CopyCapped(const std::string& source, char* out, size_t capacity) {
  if (out == nullptr || capacity == 0) return false;
  if (source.size() >= capacity) return false;  // no room for the terminator
  std::memcpy(out, source.data(), source.size());
  out[source.size()] = '\0';
  return true;
}

}  // namespace

// `cppsearch_index` is the C++ class behind the opaque pointer, so a cast is
// the whole translation between the two ABIs.
struct cppsearch_index {
  cppsearch::SearchIndex engine;
};

extern "C" {

const char* cppsearch_version(void) { return kVersion; }

cppsearch_index* cppsearch_index_create(void) {
  try {
    return new cppsearch_index();
  } catch (const std::bad_alloc&) {
    return nullptr;
  }
}

void cppsearch_index_destroy(cppsearch_index* index) { delete index; }

int cppsearch_index_upsert(cppsearch_index* index, const cppsearch_document* document) {
  if (index == nullptr || document == nullptr) return -1;
  if (document->id == nullptr || document->id[0] == '\0') return -2;

  try {
    cppsearch::DocumentInput input;
    input.id = document->id;
    input.name = SafeString(document->name);
    input.brand = SafeString(document->brand);
    input.categoryPath = SafeString(document->category_path);
    input.tags = SafeString(document->tags);
    input.attributes = SafeString(document->attributes);
    input.skus = SafeString(document->skus);
    input.description = SafeString(document->description);
    input.priceMinorUnits = document->price_minor_units;
    input.popularity = document->popularity;
    input.rating = document->rating;
    input.ratingCount = document->rating_count;

    for (size_t index = 0; index < document->attribute_count; ++index) {
      const char* key = document->attribute_keys != nullptr ? document->attribute_keys[index] : nullptr;
      const char* value = document->attribute_values != nullptr ? document->attribute_values[index] : nullptr;
      if (key == nullptr || value == nullptr) continue;
      input.attributePairs.emplace_back(key, value);
    }

    index->engine.Upsert(input);
    return 0;
  } catch (const std::exception&) {
    return -3;
  }
}

int cppsearch_index_remove(cppsearch_index* index, const char* id) {
  if (index == nullptr || id == nullptr) return -1;
  try {
    return index->engine.Remove(id) ? 1 : 0;
  } catch (const std::exception&) {
    return -1;
  }
}

size_t cppsearch_index_size(const cppsearch_index* index) {
  return index == nullptr ? 0 : index->engine.Size();
}

size_t cppsearch_index_vocabulary_size(const cppsearch_index* index) {
  return index == nullptr ? 0 : index->engine.VocabularySize();
}

void cppsearch_default_options(cppsearch_search_options* options) {
  if (options == nullptr) return;
  cppsearch::SearchOptions defaults;
  options->prefix_last_term = defaults.prefixLastTerm ? 1 : 0;
  options->max_edit_distance = defaults.maxEditDistance;
  options->min_fuzzy_length = defaults.minFuzzyLength;
  options->limit = defaults.limit;
  options->popularity_weight = defaults.popularityWeight;
  options->rating_weight = defaults.ratingWeight;
}

int cppsearch_index_search(const cppsearch_index* index, const char* query,
                           const cppsearch_search_options* options, cppsearch_hit* out_hits,
                           size_t capacity) {
  if (index == nullptr || query == nullptr || out_hits == nullptr || capacity == 0) return -1;

  try {
    cppsearch::SearchOptions engineOptions;
    if (options != nullptr) {
      engineOptions.prefixLastTerm = options->prefix_last_term != 0;
      engineOptions.maxEditDistance = options->max_edit_distance;
      engineOptions.minFuzzyLength = options->min_fuzzy_length;
      engineOptions.limit = options->limit > 0 ? options->limit : 20;
      engineOptions.popularityWeight = options->popularity_weight;
      engineOptions.ratingWeight = options->rating_weight;
    }
    engineOptions.limit = std::min(engineOptions.limit, capacity);

    const auto hits = index->engine.Search(query, engineOptions);

    g_arena.strings.clear();
    const size_t count = std::min(hits.size(), capacity);
    for (size_t index = 0; index < count; ++index) {
      out_hits[index].id = g_arena.Intern(hits[index].id);
      out_hits[index].score = hits[index].score;
      out_hits[index].matched_fields = hits[index].matchedFields;
      out_hits[index].fuzzy = hits[index].fuzzy ? 1 : 0;
    }
    return static_cast<int>(count);
  } catch (const std::exception&) {
    return -1;
  }
}

int cppsearch_index_complete(const cppsearch_index* index, const char* prefix,
                             const char** out_terms, size_t capacity) {
  if (index == nullptr || prefix == nullptr || out_terms == nullptr || capacity == 0) return -1;
  try {
    const auto terms = index->engine.CompletePrefix(prefix, capacity);
    g_arena.strings.clear();
    const size_t count = std::min(terms.size(), capacity);
    for (size_t index = 0; index < count; ++index) out_terms[index] = g_arena.Intern(terms[index]);
    return static_cast<int>(count);
  } catch (const std::exception&) {
    return -1;
  }
}

int cppsearch_index_match_attribute(const cppsearch_index* index, const char* key, const char* value,
                                    const char** out_ids, size_t capacity) {
  if (index == nullptr || key == nullptr || value == nullptr || out_ids == nullptr || capacity == 0) {
    return -1;
  }
  try {
    const auto ids = index->engine.MatchAttribute(key, value, capacity);
    g_arena.strings.clear();
    const size_t count = std::min(ids.size(), capacity);
    for (size_t index = 0; index < count; ++index) out_ids[index] = g_arena.Intern(ids[index]);
    return static_cast<int>(count);
  } catch (const std::exception&) {
    return -1;
  }
}

int cppsearch_index_fuzzy_match_attribute(const cppsearch_index* index, const char* key,
                                          const char* value, double min_similarity,
                                          const char** out_ids, size_t capacity) {
  if (index == nullptr || key == nullptr || value == nullptr || out_ids == nullptr || capacity == 0) {
    return -1;
  }
  try {
    const auto ids = index->engine.FuzzyMatchAttribute(key, value, min_similarity, capacity);
    g_arena.strings.clear();
    const size_t count = std::min(ids.size(), capacity);
    for (size_t index = 0; index < count; ++index) out_ids[index] = g_arena.Intern(ids[index]);
    return static_cast<int>(count);
  } catch (const std::exception&) {
    return -1;
  }
}

size_t cppsearch_damerau_levenshtein(const char* a, const char* b, size_t max_distance) {
  if (a == nullptr || b == nullptr) return 0;
  try {
    return cppsearch::DamerauLevenshtein(a, b, max_distance);
  } catch (const std::exception&) {
    return 0;
  }
}

double cppsearch_similarity(const char* a, const char* b) {
  if (a == nullptr || b == nullptr) return 0.0;
  try {
    return cppsearch::JaroWinkler(a, b);
  } catch (const std::exception&) {
    return 0.0;
  }
}

double cppsearch_word_similarity(const char* needle, const char* haystack) {
  if (needle == nullptr || haystack == nullptr) return 0.0;
  try {
    return cppsearch::WordSimilarity(needle, haystack);
  } catch (const std::exception&) {
    return 0.0;
  }
}

int cppsearch_tokenize(const char* text, const char** out_tokens, size_t capacity) {
  if (text == nullptr || out_tokens == nullptr || capacity == 0) return -1;
  try {
    const auto tokens = cppsearch::Tokenize(text, capacity);
    g_arena.strings.clear();
    const size_t count = std::min(tokens.size(), capacity);
    for (size_t index = 0; index < count; ++index) out_tokens[index] = g_arena.Intern(tokens[index]);
    return static_cast<int>(count);
  } catch (const std::exception&) {
    return -1;
  }
}

int cppsearch_normalize(const char* text, char* out, size_t capacity) {
  if (text == nullptr || out == nullptr || capacity == 0) return -1;
  try {
    const std::string normalized = cppsearch::Normalize(text);
    return CopyCapped(normalized, out, capacity) ? static_cast<int>(normalized.size()) : -1;
  } catch (const std::exception&) {
    return -1;
  }
}

int cppsearch_canonical_query(const char* text, char* out, size_t capacity) {
  if (text == nullptr || out == nullptr || capacity == 0) return -1;
  try {
    const std::string canonical = cppsearch::CanonicalQuery(text);
    return CopyCapped(canonical, out, capacity) ? static_cast<int>(canonical.size()) : -1;
  } catch (const std::exception&) {
    return -1;
  }
}

}  // extern "C"
