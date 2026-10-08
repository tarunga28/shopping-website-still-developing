#pragma once
// String similarity primitives.
//
// These exist in C++ rather than TypeScript for one reason: fuzzy matching is
// O(candidates × word length²), and a catalog search has to score thousands of
// candidate terms per keystroke. The algorithms here are the standard ones,
// implemented with bounded work so a long input cannot stall the service.

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>

namespace cppsearch {

/**
 * Levenshtein distance with an early-exit ceiling.
 *
 * Returns `maxDistance + 1` as soon as the distance provably exceeds
 * `maxDistance`, so ranking can ask "is this within 2 edits?" without paying for
 * the full matrix on long strings. Operates on UTF-8 code points, not bytes, so
 * an accented character counts as one edit rather than two.
 */
std::size_t Levenshtein(std::string_view a, std::string_view b, std::size_t maxDistance = 0);

/**
 * Levenshtein allowing transposition of two adjacent characters.
 * "ipohne" → "iphone" is one transposition, which plain Levenshtein scores as
 * two substitutions — and transposed letters are the single most common typo.
 */
std::size_t DamerauLevenshtein(std::string_view a, std::string_view b, std::size_t maxDistance = 0);

/** Jaro similarity in [0, 1]. */
double Jaro(std::string_view a, std::string_view b);

/**
 * Jaro-Winkler in [0, 1]: Jaro plus a prefix bonus.
 * The right default for search, because a matching prefix is strong evidence.
 */
double JaroWinkler(std::string_view a, std::string_view b, double prefixScale = 0.1);

/** Character n-gram (shingle) similarity in [0, 1] — the Dice coefficient. */
double NGramSimilarity(std::string_view a, std::string_view b, std::size_t n = 3);

/**
 * Best similarity of `needle` against any word in `haystack`.
 *
 * Mirrors PostgreSQL's `word_similarity`, which is the function the SQL search
 * path uses — keeping the two implementations aligned means the C++ engine and
 * the database agree on what a typo is.
 */
double WordSimilarity(std::string_view needle, std::string_view haystack);

/** Edit distance normalized to [0, 1] where 1 is identical. */
inline double SimilarityFromDistance(std::size_t distance, std::size_t longest) {
  if (longest == 0) return distance == 0 ? 1.0 : 0.0;
  const double ratio = 1.0 - (static_cast<double>(distance) / static_cast<double>(longest));
  return ratio < 0.0 ? 0.0 : ratio;
}

/** Longest common subsequence length (used for attribute matching). */
std::size_t LongestCommonSubsequence(std::string_view a, std::string_view b);

}  // namespace cppsearch
