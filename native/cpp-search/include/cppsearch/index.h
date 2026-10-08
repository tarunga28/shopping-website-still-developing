#pragma once
// In-memory inverted index with prefix and fuzzy term expansion.
//
// Why this lives in C++: the operations a search box triggers on every
// keystroke — tokenizing, prefix-expanding, fuzzy-expanding, and scoring
// thousands of candidates with BM25 — are pure CPU work with no I/O. Keeping
// them native means the service can re-rank a large candidate set per
// keystroke without the per-call overhead a scripting runtime would add.
//
// Scope discipline: this engine ranks a *candidate set*. Selecting which
// products are eligible (status, visibility, price band, category subtree) stays
// in PostgreSQL, where the indexes already exist. The engine is never asked to
// be the source of truth.

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace cppsearch {

/** Field weights mirror `FIELD_WEIGHTS` in `src/lib/catalog/search-text.ts`. */
enum class Field : std::uint8_t {
  kName = 0,         // A
  kBrand = 1,        // B
  kCategory = 2,     // B
  kTags = 3,         // C
  kAttributes = 4,   // C
  kSku = 5,          // C
  kDescription = 6,  // D
  kFieldCount = 7,
};

/** Relative weight per field. A name match is worth 4× a description match. */
extern const double kFieldWeights[static_cast<std::size_t>(Field::kFieldCount)];

struct DocumentInput {
  std::string id;
  std::string name;
  std::string brand;
  std::string categoryPath;
  std::string tags;
  std::string attributes;
  std::string skus;
  std::string description;
  /** Attribute pairs for exact/fast attribute matching, e.g. {"storage","256gb"}. */
  std::vector<std::pair<std::string, std::string>> attributePairs;
  std::int64_t priceMinorUnits = 0;
  double popularity = 0.0;
  double rating = 0.0;
  std::int32_t ratingCount = 0;
};

struct ScoredHit {
  std::string id;
  double score = 0.0;
  /** Which fields contributed — lets a caller explain a result to a merchandiser. */
  std::uint8_t matchedFields = 0;
  /** Set when at least one query term matched only fuzzily. */
  bool fuzzy = false;
};

struct SearchOptions {
  /** Prefix-match the final query term, as a live search box does. */
  bool prefixLastTerm = true;
  /** Maximum edit distance for fuzzy expansion of a term with no exact match. */
  std::size_t maxEditDistance = 1;
  /** Only fuzzy-expand terms at least this long; "mb" → "gb" is not a helpful guess. */
  std::size_t minFuzzyLength = 4;
  /** Stop after this many results. */
  std::size_t limit = 20;
  /** Small nudge for popular and well-rated products; bounded, never dominant. */
  double popularityWeight = 0.001;
  double ratingWeight = 0.01;
};

class SearchIndex {
 public:
  SearchIndex();

  /** Add or replace a document. Re-adding the same id overwrites it. */
  void Upsert(const DocumentInput& document);

  /** Remove a document. Returns false when the id was unknown. */
  bool Remove(const std::string& id);

  /** Number of indexed documents. */
  std::size_t Size() const { return documents_.size(); }

  /** Drop everything. */
  void Clear();

  /**
   * Rank documents against a query.
   *
   * Terms are AND-ed: a document must match every query term in at least one
   * field. A term with no exact match is fuzzy-expanded (bounded edit
   * distance) so a typo still returns results; the hit is flagged `fuzzy` so a
   * caller can label it "did you mean".
   */
  std::vector<ScoredHit> Search(std::string_view query, const SearchOptions& options = {}) const;

  /**
   * Terms in the index that start with `prefix`, best first.
   * Backs autocomplete without scanning the whole vocabulary.
   */
  std::vector<std::string> CompletePrefix(std::string_view prefix, std::size_t limit = 10) const;

  /** All distinct terms — used by the tests and by index health reporting. */
  std::size_t VocabularySize() const { return vocabulary_.size(); }

  /**
   * Documents whose attribute value matches `value` for `key`.
   *
   * Exact, case-insensitive, and O(postings) rather than O(documents) — this is
   * the "fast attribute matching" the product spec asks for, e.g. every variant
   * with storage = 256GB.
   */
  std::vector<std::string> MatchAttribute(std::string_view key, std::string_view value,
                                          std::size_t limit = 100) const;

  /** Attribute value matching allowing typos, ranked by similarity. */
  std::vector<std::string> FuzzyMatchAttribute(std::string_view key, std::string_view value,
                                               double minSimilarity = 0.6, std::size_t limit = 20) const;

 private:
  struct Posting {
    std::uint32_t documentIndex;
    Field field;
    std::uint32_t termFrequency;
  };

  struct StoredDocument {
    std::string id;
    std::uint32_t totalTerms = 0;
    std::int64_t priceMinorUnits = 0;
    double popularity = 0.0;
    double rating = 0.0;
    std::int32_t ratingCount = 0;
    std::unordered_map<std::string, std::string> attributePairs;
  };

  void IndexField(std::uint32_t documentIndex, Field field, std::string_view text);
  void UnindexDocument(std::uint32_t documentIndex);
  /** Sort the vocabulary for prefix lookup; a no-op unless the index changed. */
  void EnsureSortedVocabulary() const;
  /** Term ids whose vocabulary entry is within `maxDistance` edits of `term`. */
  std::vector<std::string> ExpandFuzzy(const std::string& term, std::size_t maxDistance) const;
  std::vector<std::string> ExpandPrefix(const std::string& term) const;

  std::vector<StoredDocument> documents_;
  std::unordered_map<std::string, std::uint32_t> idToIndex_;
  /** term -> postings */
  std::unordered_map<std::string, std::vector<Posting>> vocabulary_;
  /** "key\u0001value" -> document indices, for fast attribute lookup */
  std::unordered_map<std::string, std::vector<std::uint32_t>> attributeIndex_;
  /** Average document length across all fields, for BM25 normalization. */
  double averageLength_ = 0.0;
  std::uint64_t totalTerms_ = 0;
  /**
   * Vocabulary keys kept sorted, so prefix lookup is a binary search plus a
   * linear walk over only the matching range instead of a scan of every term.
   *
   * Rebuilt lazily: a bulk load touches it zero times, and the first prefix
   * query after a mutation pays one sort. Mutable because searching a const
   * index is allowed to maintain this cache.
   */
  mutable std::vector<std::string> sortedVocabulary_;
  mutable bool vocabularySorted_ = true;
  /**
   * Character-bigram index over the vocabulary, used to prefilter fuzzy
   * candidates. Two terms within one edit of each other share at least one
   * bigram, so nothing is missed — but the vast majority of the vocabulary is
   * never compared at all. Built lazily with the sorted vocabulary.
   */
  mutable std::unordered_map<std::string, std::vector<std::string>> bigramIndex_;
  void EnsureBigramIndex() const;
};

}  // namespace cppsearch
