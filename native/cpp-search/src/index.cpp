#include "cppsearch/index.h"

#include <algorithm>
#include <cmath>
#include <unordered_set>

#include "cppsearch/similarity.h"
#include "cppsearch/tokenizer.h"

namespace cppsearch {

const double kFieldWeights[static_cast<std::size_t>(Field::kFieldCount)] = {
    4.0,  // kName        (A)
    2.5,  // kBrand       (B)
    2.5,  // kCategory    (B)
    1.6,  // kTags        (C)
    1.6,  // kAttributes  (C)
    1.4,  // kSku         (C)
    1.0,  // kDescription (D)
};

namespace {

constexpr double kBm25K1 = 1.2;
/** Sentinel for "this document has not been credited for any query term yet". */
constexpr std::uint32_t kNoTerm = 0xFFFFFFFFu;
constexpr double kBm25B = 0.75;

std::string AttributeKey(std::string_view key, std::string_view value) {
  std::string out;
  out.reserve(key.size() + value.size() + 1);
  out.append(key);
  out.push_back('\x01');
  out.append(value);
  return out;
}

}  // namespace

SearchIndex::SearchIndex() = default;

void SearchIndex::IndexField(std::uint32_t documentIndex, Field field, std::string_view text) {
  if (text.empty()) return;

  // Count frequencies for this field first, then append one posting per term.
  // Doing this inline instead would scan the whole posting list for every token
  // occurrence, which turns indexing a common term into quadratic work.
  std::unordered_map<std::string, std::uint32_t> frequencies;
  std::uint32_t termCount = 0;
  for (const auto& token : Tokenize(text)) {
    ++frequencies[token];
    ++termCount;
  }
  if (termCount == 0) return;

  for (const auto& [token, frequency] : frequencies) {
    vocabulary_[token].push_back(Posting{documentIndex, field, frequency});
    vocabularySorted_ = false;
  }
  totalTerms_ += termCount;
  documents_[documentIndex].totalTerms += termCount;
}

void SearchIndex::EnsureBigramIndex() const {
  bigramIndex_.clear();
  EnsureSortedVocabulary();
  for (const auto& term : sortedVocabulary_) {
    if (term.size() < 2) {
      bigramIndex_[term].push_back(term);
      continue;
    }
    for (std::size_t offset = 0; offset + 2 <= term.size(); ++offset) {
      bigramIndex_[term.substr(offset, 2)].push_back(term);
    }
  }
}

void SearchIndex::EnsureSortedVocabulary() const {
  if (vocabularySorted_) return;
  sortedVocabulary_.clear();
  sortedVocabulary_.reserve(vocabulary_.size());
  for (const auto& [term, postings] : vocabulary_) {
    if (postings.empty()) continue;
    sortedVocabulary_.push_back(term);
  }
  std::sort(sortedVocabulary_.begin(), sortedVocabulary_.end());
  vocabularySorted_ = true;
}

void SearchIndex::UnindexDocument(std::uint32_t documentIndex) {
  for (auto& [term, postings] : vocabulary_) {
    postings.erase(std::remove_if(postings.begin(), postings.end(),
                                  [&](const Posting& posting) {
                                    return posting.documentIndex == documentIndex;
                                  }),
                   postings.end());
  }
  for (auto& [key, indices] : attributeIndex_) {
    indices.erase(std::remove(indices.begin(), indices.end(), documentIndex), indices.end());
  }
  // Compact: drop terms nothing points at any more, so the vocabulary does not
  // grow without bound across repeated re-indexes.
  for (auto iterator = vocabulary_.begin(); iterator != vocabulary_.end();) {
    if (iterator->second.empty()) {
      iterator = vocabulary_.erase(iterator);
    } else {
      ++iterator;
    }
  }
  vocabularySorted_ = false;
}

void SearchIndex::Upsert(const DocumentInput& document) {
  const auto existing = idToIndex_.find(document.id);
  std::uint32_t documentIndex;

  if (existing != idToIndex_.end()) {
    documentIndex = existing->second;
    totalTerms_ -= documents_[documentIndex].totalTerms;
    UnindexDocument(documentIndex);
    documents_[documentIndex] = StoredDocument{};
  } else {
    documentIndex = static_cast<std::uint32_t>(documents_.size());
    documents_.emplace_back();
    idToIndex_[document.id] = documentIndex;
  }

  auto& stored = documents_[documentIndex];
  stored.id = document.id;
  stored.priceMinorUnits = document.priceMinorUnits;
  stored.popularity = document.popularity;
  stored.rating = document.rating;
  stored.ratingCount = document.ratingCount;

  for (const auto& pair : document.attributePairs) {
    stored.attributePairs[pair.first] = pair.second;
    attributeIndex_[AttributeKey(pair.first, pair.second)].push_back(documentIndex);
  }

  IndexField(documentIndex, Field::kName, document.name);
  IndexField(documentIndex, Field::kBrand, document.brand);
  IndexField(documentIndex, Field::kCategory, document.categoryPath);
  IndexField(documentIndex, Field::kTags, document.tags);
  IndexField(documentIndex, Field::kAttributes, document.attributes);
  IndexField(documentIndex, Field::kSku, document.skus);
  IndexField(documentIndex, Field::kDescription, document.description);

  // Attribute values are searchable text too, so "256gb" finds the phone even
  // when the merchant never put the capacity in the product name.
  for (const auto& pair : document.attributePairs) {
    IndexField(documentIndex, Field::kAttributes, pair.second);
  }

  averageLength_ = documents_.empty()
                       ? 0.0
                       : static_cast<double>(totalTerms_) / static_cast<double>(documents_.size());
}

bool SearchIndex::Remove(const std::string& id) {
  const auto iterator = idToIndex_.find(id);
  if (iterator == idToIndex_.end()) return false;

  const std::uint32_t documentIndex = iterator->second;
  totalTerms_ -= documents_[documentIndex].totalTerms;
  UnindexDocument(documentIndex);

  // Tombstone rather than erase: indices are referenced by every posting list,
  // so compacting them would cost a full reindex. Cleared id marks it dead.
  idToIndex_.erase(iterator);
  documents_[documentIndex].id.clear();
  documents_[documentIndex].totalTerms = 0;

  averageLength_ = documents_.empty()
                       ? 0.0
                       : static_cast<double>(totalTerms_) / static_cast<double>(documents_.size());
  return true;
}

void SearchIndex::Clear() {
  documents_.clear();
  idToIndex_.clear();
  vocabulary_.clear();
  attributeIndex_.clear();
  sortedVocabulary_.clear();
  bigramIndex_.clear();
  vocabularySorted_ = true;
  averageLength_ = 0.0;
  totalTerms_ = 0;
}

std::vector<std::string> SearchIndex::ExpandPrefix(const std::string& term) const {
  std::vector<std::string> matches;
  if (term.empty()) return matches;
  matches.reserve(8);
  EnsureSortedVocabulary();

  // Binary search to the first term that could start with `prefix`, then walk
  // forward only while it still does. Sorted order makes every prefix match
  // contiguous, so unrelated terms are never compared.
  const auto start = std::lower_bound(sortedVocabulary_.begin(), sortedVocabulary_.end(), term);
  for (auto iterator = start; iterator != sortedVocabulary_.end(); ++iterator) {
    if (iterator->compare(0, term.size(), term) != 0) break;
    matches.push_back(*iterator);
    if (matches.size() >= 32) break;
  }
  return matches;
}

std::vector<std::string> SearchIndex::ExpandFuzzy(const std::string& term, std::size_t maxDistance) const {
  std::vector<std::string> matches;
  if (term.empty() || maxDistance == 0) return matches;

  EnsureBigramIndex();

  // Collect only terms sharing a bigram with the query term, then verify with
  // the real edit distance. This is a lossless prefilter: any term within
  // `maxDistance` edits keeps at least one bigram in common.
  std::vector<std::string> candidates;
  std::unordered_set<std::string> seen;
  if (term.size() < 2) {
    const auto exact = bigramIndex_.find(term);
    if (exact != bigramIndex_.end()) candidates = exact->second;
  } else {
    for (std::size_t offset = 0; offset + 2 <= term.size(); ++offset) {
      const auto bucket = bigramIndex_.find(term.substr(offset, 2));
      if (bucket == bigramIndex_.end()) continue;
      for (const auto& candidate : bucket->second) {
        if (seen.insert(candidate).second) candidates.push_back(candidate);
      }
    }
  }

  for (const auto& vocabularyTerm : candidates) {
    // Length filter next: strings differing in length by more than the allowed
    // distance cannot be within it, and this check is far cheaper than the
    // edit-distance computation it avoids.
    const std::size_t lengthDifference = vocabularyTerm.size() > term.size()
                                             ? vocabularyTerm.size() - term.size()
                                             : term.size() - vocabularyTerm.size();
    if (lengthDifference > maxDistance) continue;
    const auto postings = vocabulary_.find(vocabularyTerm);
    if (postings == vocabulary_.end() || postings->second.empty()) continue;
    if (DamerauLevenshtein(term, vocabularyTerm, maxDistance) <= maxDistance) {
      matches.push_back(vocabularyTerm);
      if (matches.size() >= 16) break;
    }
  }
  return matches;
}

std::vector<ScoredHit> SearchIndex::Search(std::string_view query, const SearchOptions& options) const {
  std::vector<ScoredHit> results;
  const auto tokens = Tokenize(SanitizeQuery(query), 8);
  if (tokens.empty() || documents_.empty()) return results;

  const double documentCount = static_cast<double>(documents_.size());

  // Per-document accumulators: BM25 sums over query terms, so each term adds to
  // the score of the documents it appears in.
  // Flat arrays indexed by the dense document index rather than hash maps:
  // scoring visits every posting, so four hash operations per posting was the
  // dominant cost. `touched` records which documents to sweep afterwards, so
  // the arrays never have to be scanned in full.
  std::vector<double> scores(documents_.size(), 0.0);
  std::vector<std::uint8_t> matchedFieldBits(documents_.size(), 0);
  std::vector<std::uint32_t> satisfiedCounts(documents_.size(), 0);
  std::vector<std::uint32_t> lastTermCredited(documents_.size(), kNoTerm);
  std::vector<bool> fuzzyFlags(documents_.size(), false);
  std::vector<std::uint32_t> touched;
  touched.reserve(256);

  for (std::size_t termIndex = 0; termIndex < tokens.size(); ++termIndex) {
    const bool isLastTerm = termIndex + 1 == tokens.size();

    std::vector<const std::pair<const std::string, std::vector<Posting>>*> termPostings;
    bool termIsFuzzy = false;

    const auto exact = vocabulary_.find(tokens[termIndex]);
    if (exact != vocabulary_.end() && !exact->second.empty()) {
      termPostings.push_back(&(*exact));
    }

    // Prefix expansion of the final term: the shopper is mid-word, and the
    // completed forms are the ones they mean.
    if (isLastTerm && options.prefixLastTerm) {
      for (const auto& expansion : ExpandPrefix(tokens[termIndex])) {
        const auto iterator = vocabulary_.find(expansion);
        if (iterator == vocabulary_.end() || iterator->second.empty()) continue;
        if (std::any_of(termPostings.begin(), termPostings.end(),
                        [&](const auto* entry) { return &(*entry) == &(*iterator); })) {
          continue;
        }
        termPostings.push_back(&(*iterator));
      }
    }

    // Nothing matched at all: fall back to fuzzy, so a typo returns results
    // rather than an empty page.
    if (termPostings.empty() && tokens[termIndex].size() >= options.minFuzzyLength) {
      for (const auto& expansion : ExpandFuzzy(tokens[termIndex], options.maxEditDistance)) {
        const auto iterator = vocabulary_.find(expansion);
        if (iterator != vocabulary_.end() && !iterator->second.empty()) {
          termPostings.push_back(&(*iterator));
          termIsFuzzy = true;
        }
      }
    }

    if (termPostings.empty()) {
      // An AND query with an unmatched term has no results. Report that
      // explicitly rather than silently widening the query.
      return {};
    }

    for (const auto* entry : termPostings) {
      const double documentFrequency = static_cast<double>(entry->second.size());
      const double inverseDocumentFrequency =
          std::log(1.0 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));

      for (const auto& posting : entry->second) {
        const auto& document = documents_[posting.documentIndex];
        if (document.id.empty()) continue;  // tombstoned

        const double documentLength = static_cast<double>(document.totalTerms);
        const double normalization =
            kBm25K1 *
            (1.0 - kBm25B + kBm25B * (averageLength_ > 0.0 ? documentLength / averageLength_ : 1.0));
        const double termScore =
            inverseDocumentFrequency *
            ((static_cast<double>(posting.termFrequency) * (kBm25K1 + 1.0)) /
             (static_cast<double>(posting.termFrequency) + normalization));

        const std::uint32_t documentIndex = posting.documentIndex;
        if (scores[documentIndex] == 0.0) touched.push_back(documentIndex);
        scores[documentIndex] +=
            termScore * kFieldWeights[static_cast<std::size_t>(posting.field)];
        matchedFieldBits[documentIndex] |=
            static_cast<std::uint8_t>(1u << static_cast<unsigned>(posting.field));
        if (termIsFuzzy) fuzzyFlags[documentIndex] = true;

        // Credit the term once per document, however many expanded forms hit it.
        if (lastTermCredited[documentIndex] != static_cast<std::uint32_t>(termIndex)) {
          lastTermCredited[documentIndex] = static_cast<std::uint32_t>(termIndex);
          ++satisfiedCounts[documentIndex];
        }
      }
    }
  }

  const std::uint32_t requiredTerms = static_cast<std::uint32_t>(tokens.size());
  for (const auto documentIndex : touched) {
    if (satisfiedCounts[documentIndex] < requiredTerms) continue;

    const auto& document = documents_[documentIndex];
    // Bounded nudges: popularity and rating can reorder close matches but can
    // never lift a weak text match above a strong one.
    const double popularityNudge =
        std::min(document.popularity, 100.0) * options.popularityWeight;
    const double ratingNudge = std::max(0.0, std::min(document.rating, 5.0)) * options.ratingWeight;

    ScoredHit hit;
    hit.id = document.id;
    hit.score = scores[documentIndex] + popularityNudge + ratingNudge;
    hit.matchedFields = matchedFieldBits[documentIndex];
    hit.fuzzy = fuzzyFlags[documentIndex];
    results.push_back(std::move(hit));
  }

  std::sort(results.begin(), results.end(), [](const ScoredHit& a, const ScoredHit& b) {
    if (a.score != b.score) return a.score > b.score;
    return a.id < b.id;  // deterministic tie-break, so pagination is stable
  });
  if (results.size() > options.limit) results.resize(options.limit);
  return results;
}

std::vector<std::string> SearchIndex::CompletePrefix(std::string_view prefix, std::size_t limit) const {
  const auto normalized = Normalize(prefix);
  std::vector<std::pair<std::string, std::size_t>> candidates;
  EnsureSortedVocabulary();

  const auto start = std::lower_bound(sortedVocabulary_.begin(), sortedVocabulary_.end(), normalized);
  for (auto iterator = start; iterator != sortedVocabulary_.end(); ++iterator) {
    if (iterator->compare(0, normalized.size(), normalized) != 0) break;
    const auto postings = vocabulary_.find(*iterator);
    if (postings == vocabulary_.end()) continue;
    candidates.emplace_back(*iterator, postings->second.size());
  }

  // Most common terms first: the autocomplete that helps is the one that
  // suggests what people actually search for.
  std::sort(candidates.begin(), candidates.end(),
            [](const auto& a, const auto& b) { return a.second > b.second; });

  std::vector<std::string> out;
  out.reserve(std::min(limit, candidates.size()));
  for (std::size_t index = 0; index < candidates.size() && out.size() < limit; ++index) {
    out.push_back(std::move(candidates[index].first));
  }
  return out;
}

std::vector<std::string> SearchIndex::MatchAttribute(std::string_view key, std::string_view value,
                                                     std::size_t limit) const {
  const auto iterator = attributeIndex_.find(AttributeKey(key, value));
  std::vector<std::string> out;
  if (iterator == attributeIndex_.end()) return out;

  out.reserve(std::min(limit, iterator->second.size()));
  for (const auto documentIndex : iterator->second) {
    if (out.size() >= limit) break;
    const auto& document = documents_[documentIndex];
    if (document.id.empty()) continue;
    out.push_back(document.id);
  }
  return out;
}

std::vector<std::string> SearchIndex::FuzzyMatchAttribute(std::string_view key,
                                                          std::string_view value,
                                                          double minSimilarity,
                                                          std::size_t limit) const {
  const std::string keyPrefix(key);
  std::vector<std::pair<std::string, double>> candidates;

  for (const auto& [compositeKey, indices] : attributeIndex_) {
    if (compositeKey.size() <= keyPrefix.size() + 1) continue;
    if (compositeKey.compare(0, keyPrefix.size(), keyPrefix) != 0) continue;
    if (compositeKey[keyPrefix.size()] != '\x01') continue;

    const std::string candidateValue = compositeKey.substr(keyPrefix.size() + 1);
    const double similarity = std::max(JaroWinkler(value, candidateValue),
                                       NGramSimilarity(value, candidateValue, 3));
    if (similarity < minSimilarity) continue;
    candidates.emplace_back(candidateValue, similarity);
  }

  std::sort(candidates.begin(), candidates.end(),
            [](const auto& a, const auto& b) { return a.second > b.second; });

  std::vector<std::string> out;
  out.reserve(limit);
  for (const auto& candidate : candidates) {
    if (out.size() >= limit) break;
    const auto iterator = attributeIndex_.find(AttributeKey(key, candidate.first));
    if (iterator == attributeIndex_.end()) continue;
    for (const auto documentIndex : iterator->second) {
      if (out.size() >= limit) break;
      const auto& document = documents_[documentIndex];
      if (document.id.empty()) continue;
      if (std::find(out.begin(), out.end(), document.id) != out.end()) continue;
      out.push_back(document.id);
    }
  }
  return out;
}

}  // namespace cppsearch
