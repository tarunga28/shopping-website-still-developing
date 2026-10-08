#include "cppsearch/similarity.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace cppsearch {
namespace {

/** Decode `text` into code points once, so the O(n²) loops do not re-decode. */
std::vector<std::uint32_t> ToCodePoints(std::string_view text) {
  std::vector<std::uint32_t> points;
  points.reserve(text.size());
  std::size_t pos = 0;
  while (pos < text.size()) {
    const auto first = static_cast<unsigned char>(text[pos]);
    std::size_t length = 1;
    std::uint32_t codePoint = first;
    if (first < 0x80u) {
      length = 1;
    } else if ((first & 0xE0u) == 0xC0u) {
      length = 2;
      codePoint = first & 0x1Fu;
    } else if ((first & 0xF0u) == 0xE0u) {
      length = 3;
      codePoint = first & 0x0Fu;
    } else if ((first & 0xF8u) == 0xF0u) {
      length = 4;
      codePoint = first & 0x07u;
    } else {
      ++pos;
      continue;
    }
    if (pos + length > text.size()) break;
    bool valid = true;
    for (std::size_t offset = 1; offset < length; ++offset) {
      if ((static_cast<unsigned char>(text[pos + offset]) & 0xC0u) != 0x80u) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (static_cast<unsigned char>(text[pos + offset]) & 0x3Fu);
    }
    if (!valid) {
      ++pos;
      continue;
    }
    points.push_back(codePoint);
    pos += length;
  }
  return points;
}

/** Two rolling rows are enough for Levenshtein; a full matrix would be waste. */
std::size_t EditDistanceCore(const std::vector<std::uint32_t>& a,
                             const std::vector<std::uint32_t>& b,
                             std::size_t maxDistance,
                             bool allowTransposition) {
  if (a.empty()) return b.size();
  if (b.empty()) return a.size();
  if (maxDistance > 0) {
    const std::size_t difference = a.size() > b.size() ? a.size() - b.size() : b.size() - a.size();
    if (difference > maxDistance) return maxDistance + 1;
  }

  std::vector<std::size_t> previous(b.size() + 1);
  std::vector<std::size_t> current(b.size() + 1);
  // Damerau needs the row before `previous` to look at a transposition.
  std::vector<std::size_t> beforePrevious(b.size() + 1);

  for (std::size_t column = 0; column <= b.size(); ++column) previous[column] = column;

  for (std::size_t i = 1; i <= a.size(); ++i) {
    current[0] = i;
    std::size_t rowMinimum = current[0];

    for (std::size_t j = 1; j <= b.size(); ++j) {
      const std::size_t substitutionCost = a[i - 1] == b[j - 1] ? 0 : 1;
      std::size_t best = std::min(previous[j] + 1, current[j - 1] + 1);
      best = std::min(best, previous[j - 1] + substitutionCost);

      if (allowTransposition && i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) {
        best = std::min(best, beforePrevious[j - 2] + 1);
      }

      current[j] = best;
      rowMinimum = std::min(rowMinimum, best);
    }

    // Every cell in the next row is at least `rowMinimum`, so once the whole row
    // exceeds the ceiling the final distance must too.
    if (maxDistance > 0 && rowMinimum > maxDistance) return maxDistance + 1;

    if (allowTransposition) beforePrevious = previous;
    previous = current;
  }
  return previous[b.size()];
}

}  // namespace

std::size_t Levenshtein(std::string_view a, std::string_view b, std::size_t maxDistance) {
  const auto pointsA = ToCodePoints(a);
  const auto pointsB = ToCodePoints(b);
  return EditDistanceCore(pointsA, pointsB, maxDistance, /*allowTransposition=*/false);
}

std::size_t DamerauLevenshtein(std::string_view a, std::string_view b, std::size_t maxDistance) {
  const auto pointsA = ToCodePoints(a);
  const auto pointsB = ToCodePoints(b);
  return EditDistanceCore(pointsA, pointsB, maxDistance, /*allowTransposition=*/true);
}

double Jaro(std::string_view a, std::string_view b) {
  const auto pointsA = ToCodePoints(a);
  const auto pointsB = ToCodePoints(b);
  if (pointsA.empty() && pointsB.empty()) return 1.0;
  if (pointsA.empty() || pointsB.empty()) return 0.0;

  const std::size_t matchWindow =
      std::max(pointsA.size(), pointsB.size()) / 2 > 0 ? std::max(pointsA.size(), pointsB.size()) / 2 - 1 : 0;

  std::vector<bool> matchedA(pointsA.size(), false);
  std::vector<bool> matchedB(pointsB.size(), false);
  std::size_t matches = 0;

  for (std::size_t i = 0; i < pointsA.size(); ++i) {
    const std::size_t start = i > matchWindow ? i - matchWindow : 0;
    const std::size_t end = std::min(i + matchWindow + 1, pointsB.size());
    for (std::size_t j = start; j < end; ++j) {
      if (matchedB[j] || pointsA[i] != pointsB[j]) continue;
      matchedA[i] = true;
      matchedB[j] = true;
      ++matches;
      break;
    }
  }
  if (matches == 0) return 0.0;

  std::size_t transpositions = 0;
  std::size_t cursor = 0;
  for (std::size_t i = 0; i < pointsA.size(); ++i) {
    if (!matchedA[i]) continue;
    while (!matchedB[cursor]) ++cursor;
    if (pointsA[i] != pointsB[cursor]) ++transpositions;
    ++cursor;
  }

  const double matchCount = static_cast<double>(matches);
  return (matchCount / static_cast<double>(pointsA.size()) +
          matchCount / static_cast<double>(pointsB.size()) +
          (matchCount - static_cast<double>(transpositions) / 2.0) / matchCount) /
         3.0;
}

double JaroWinkler(std::string_view a, std::string_view b, double prefixScale) {
  const double jaro = Jaro(a, b);
  const auto pointsA = ToCodePoints(a);
  const auto pointsB = ToCodePoints(b);

  std::size_t prefix = 0;
  const std::size_t limit = std::min({pointsA.size(), pointsB.size(), static_cast<std::size_t>(4)});
  while (prefix < limit && pointsA[prefix] == pointsB[prefix]) ++prefix;

  const double scale = std::clamp(prefixScale, 0.0, 0.25);
  return jaro + static_cast<double>(prefix) * scale * (1.0 - jaro);
}

double NGramSimilarity(std::string_view a, std::string_view b, std::size_t n) {
  if (n == 0) return 0.0;
  const auto pointsA = ToCodePoints(a);
  const auto pointsB = ToCodePoints(b);
  if (pointsA.size() < n || pointsB.size() < n) {
    // Shorter than one shingle: fall back to exact equality so a two-letter SKU
    // is not scored as "no similarity" against itself.
    return pointsA == pointsB ? 1.0 : 0.0;
  }

  const auto shingles = [&](const std::vector<std::uint32_t>& points) {
    std::unordered_multiset<std::u32string> set;
    for (std::size_t i = 0; i + n <= points.size(); ++i) {
      set.insert(std::u32string(points.begin() + static_cast<long>(i),
                                points.begin() + static_cast<long>(i + n)));
    }
    return set;
  };

  auto setA = shingles(pointsA);
  const auto setB = shingles(pointsB);
  if (setA.empty() || setB.empty()) return 0.0;

  std::size_t intersection = 0;
  for (const auto& shingle : setB) {
    auto found = setA.find(shingle);
    if (found == setA.end()) continue;
    setA.erase(found);
    ++intersection;
  }

  const double total = static_cast<double>(setB.size() + (pointsA.size() - n + 1));
  if (total == 0.0) return 0.0;
  return (2.0 * static_cast<double>(intersection)) / total;
}

double WordSimilarity(std::string_view needle, std::string_view haystack) {
  const auto words = [&]() {
    std::vector<std::string> result;
    std::string current;
    for (const char character : haystack) {
      const auto byte = static_cast<unsigned char>(character);
      const bool isWordByte = byte >= 0x80u || std::isalnum(byte) != 0;
      if (isWordByte) {
        current.push_back(character);
      } else if (!current.empty()) {
        result.push_back(current);
        current.clear();
      }
    }
    if (!current.empty()) result.push_back(current);
    return result;
  }();

  if (words.empty()) return 0.0;

  double best = 0.0;
  for (const auto& word : words) {
    // Trigram similarity matches the PostgreSQL `word_similarity` definition
    // closely enough that the two engines agree on which typos to accept.
    const double score = NGramSimilarity(needle, word, 3);
    if (score > best) best = score;
  }
  return best;
}

std::size_t LongestCommonSubsequence(std::string_view a, std::string_view b) {
  const auto pointsA = ToCodePoints(a);
  const auto pointsB = ToCodePoints(b);
  if (pointsA.empty() || pointsB.empty()) return 0;

  std::vector<std::size_t> previous(pointsB.size() + 1, 0);
  std::vector<std::size_t> current(pointsB.size() + 1, 0);

  for (std::size_t i = 1; i <= pointsA.size(); ++i) {
    for (std::size_t j = 1; j <= pointsB.size(); ++j) {
      current[j] = pointsA[i - 1] == pointsB[j - 1]
                       ? previous[j - 1] + 1
                       : std::max(previous[j], current[j - 1]);
    }
    std::swap(previous, current);
  }
  return previous[pointsB.size()];
}

}  // namespace cppsearch
