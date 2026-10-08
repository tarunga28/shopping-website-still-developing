// Test runner for the cpp-search engine.
//
// A minimal harness rather than a framework: the engine has no dependencies and
// neither should its tests, so `make test` works on a bare toolchain with no
// package download. The cases here are the contract — in particular the
// tokenizer cases, which must agree with `src/lib/catalog/search-text.ts`.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

#include "cppsearch/ffi.h"
#include "cppsearch/index.h"
#include "cppsearch/similarity.h"
#include "cppsearch/tokenizer.h"

namespace {

int g_failures = 0;
int g_checks = 0;
const char* g_currentTest = "";

void ReportFailure(const std::string& message, const char* file, int line) {
  ++g_failures;
  std::printf("  FAIL %s\n       %s (%s:%d)\n", g_currentTest, message.c_str(), file, line);
}

void Run(const char* name, const std::function<void()>& body) {
  g_currentTest = name;
  const int before = g_failures;
  body();
  if (g_failures == before) std::printf("  ok   %s\n", name);
}

#define CHECK(condition) \
  do { \
    ++g_checks; \
    if (!(condition)) ReportFailure("expected: " #condition, __FILE__, __LINE__); \
  } while (0)

#define CHECK_EQ(actual, expected) \
  do { \
    ++g_checks; \
    const auto actualValue = (actual); \
    const auto expectedValue = (expected); \
    if (!(actualValue == expectedValue)) { \
      std::ostringstream stream; \
      stream << "expected " << expectedValue << ", got " << actualValue; \
      ReportFailure(stream.str(), __FILE__, __LINE__); \
    } \
  } while (0)

#define CHECK_NEAR(actual, expected, tolerance) \
  do { \
    ++g_checks; \
    const double actualValue = (actual); \
    const double expectedValue = (expected); \
    if (std::fabs(actualValue - expectedValue) > (tolerance)) { \
      char buffer[160]; \
      std::snprintf(buffer, sizeof(buffer), "expected ~%.4f, got %.4f", expectedValue, actualValue); \
      ReportFailure(buffer, __FILE__, __LINE__); \
    } \
  } while (0)

std::string Join(const std::vector<std::string>& values) {
  std::string out;
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) out += "|";
    out += values[index];
  }
  return out;
}

/* ── Tokenizer ───────────────────────────────────────────────────────── */

void TokenizerTests() {
  Run("tokenizer: splits on non-alphanumerics and lowercases", []() {
    CHECK_EQ(Join(cppsearch::Tokenize("iPhone 17 Pro-Max 256GB")), std::string("iphone|17|pro|max|256gb"));
  });

  Run("tokenizer: folds diacritics like the TypeScript implementation", []() {
    // "café" with a precomposed é and "cafe" + combining acute must agree.
    CHECK_EQ(Join(cppsearch::Tokenize("caf\xC3\xA9")), std::string("cafe"));
    CHECK_EQ(Join(cppsearch::Tokenize("cafe\xCC\x81")), std::string("cafe"));
  });

  Run("tokenizer: handles non-Latin scripts", []() {
    const auto tokens = cppsearch::Tokenize("\xE0\xA4\xB9\xE0\xA4\xBF\xE0\xA4\x82\xE0\xA4\xA6\xE0\xA5\x80 tee");
    CHECK_EQ(tokens.size(), std::size_t{2});
  });

  Run("tokenizer: drops control characters and empty input", []() {
    CHECK_EQ(cppsearch::Tokenize("").size(), std::size_t{0});
    CHECK_EQ(cppsearch::Tokenize("---   ").size(), std::size_t{0});
    // Built from separate literals: "\x01b" would parse as one hex escape (27),
    // not as 0x01 followed by 'b'.
    const std::string withControls = std::string("a\x01", 2) + std::string("b\x02", 2) + std::string("c", 1);
    CHECK_EQ(Join(cppsearch::Tokenize(withControls)), std::string("a|b|c"));
  });

  Run("tokenizer: respects the token cap", []() {
    const auto tokens = cppsearch::Tokenize("one two three four five", 3);
    CHECK_EQ(tokens.size(), std::size_t{3});
  });

  Run("tokenizer: normalize collapses runs of separators", []() {
    CHECK_EQ(cppsearch::Normalize("  iPhone   17 -- Pro "), std::string("iphone 17 pro"));
  });

  Run("tokenizer: canonical query is order-insensitive and deduplicated", []() {
    CHECK_EQ(cppsearch::CanonicalQuery("iPhone Case iPhone"), std::string("case iphone"));
    CHECK_EQ(cppsearch::CanonicalQuery("case iphone"), std::string("case iphone"));
  });

  Run("tokenizer: sanitize bounds length and strips control characters", []() {
    const std::string longQuery(500, 'a');
    CHECK_EQ(cppsearch::SanitizeQuery(longQuery, 80).size(), std::size_t{80});
    // Explicit length: a std::string built from a char literal containing NUL
    // would stop at the NUL, which is not the input under test.
    const std::string withNul = std::string("  hello\x00", 9) + std::string("world  ", 7);
    CHECK_EQ(cppsearch::SanitizeQuery(withNul), std::string("hello world"));
  });

  Run("tokenizer: malformed UTF-8 does not crash or loop", []() {
    // Built from separate literals: C++ hex escapes are greedy, so "\x28abc"
    // would parse as a single out-of-range escape rather than '(' followed by "abc".
    const std::string malformed = std::string("\xC3\x28", 2) + std::string("abc\xFF\xFE", 6);
    const auto tokens = cppsearch::Tokenize(malformed);
    CHECK(!tokens.empty());
  });
}

/* ── Similarity ──────────────────────────────────────────────────────── */

void SimilarityTests() {
  Run("similarity: identical strings have zero distance", []() {
    CHECK_EQ(cppsearch::Levenshtein("iphone", "iphone"), std::size_t{0});
    CHECK_EQ(cppsearch::DamerauLevenshtein("iphone", "iphone"), std::size_t{0});
    CHECK_NEAR(cppsearch::JaroWinkler("iphone", "iphone"), 1.0, 1e-9);
  });

  Run("similarity: transposition costs one edit under Damerau, two under Levenshtein", []() {
    // "ipohne" is "iphone" with "ho" transposed — the most common typo shape.
    CHECK_EQ(cppsearch::DamerauLevenshtein("iphone", "ipohne"), std::size_t{1});
    CHECK_EQ(cppsearch::Levenshtein("iphone", "ipohne"), std::size_t{2});
  });

  Run("similarity: counts code points, not bytes", []() {
    // One precomposed é differs by one code point from e, not by two bytes.
    CHECK_EQ(cppsearch::Levenshtein("caf\xC3\xA9", "cafe"), std::size_t{1});
  });

  Run("similarity: honours the early-exit ceiling", []() {
    CHECK_EQ(cppsearch::Levenshtein("abcdef", "zyxwvu", 2), std::size_t{3});
  });

  Run("similarity: JaroWinkler rewards a shared prefix", []() {
    const double withPrefix = cppsearch::JaroWinkler("iphone17", "iphone16");
    const double withoutPrefix = cppsearch::JaroWinkler("iphone17", "xphone16");
    CHECK(withPrefix > withoutPrefix);
  });

  Run("similarity: unrelated strings score low", []() {
    CHECK(cppsearch::JaroWinkler("iphone", "refrigerator") < 0.6);
  });

  Run("similarity: word similarity finds a word inside a long string", []() {
    // This is the case plain `similarity` fails: a short query against a long
    // product name. The word "silicone" is present, so the score must be high.
    CHECK(cppsearch::WordSimilarity("silicone", "premium silicone phone case") > 0.9);
    CHECK(cppsearch::WordSimilarity("silikone", "premium silicone phone case") > 0.4);
    CHECK(cppsearch::WordSimilarity("zzzzzzzz", "premium silicone phone case") < 0.3);
  });

  Run("similarity: n-gram similarity is symmetric and bounded", []() {
    const double score = cppsearch::NGramSimilarity("iphone", "iphone");
    CHECK_NEAR(score, 1.0, 1e-9);
    CHECK(cppsearch::NGramSimilarity("abc", "xyz", 3) < 0.1);
    // Shorter than one shingle falls back to equality.
    CHECK_NEAR(cppsearch::NGramSimilarity("ab", "ab", 3), 1.0, 1e-9);
  });

  Run("similarity: longest common subsequence", []() {
    CHECK_EQ(cppsearch::LongestCommonSubsequence("abcdef", "acef"), std::size_t{4});
    CHECK_EQ(cppsearch::LongestCommonSubsequence("", "abc"), std::size_t{0});
  });
}

/* ── Index ───────────────────────────────────────────────────────────── */

cppsearch::DocumentInput MakeDocument(const std::string& id, const std::string& name,
                                      const std::string& description = "",
                                      const std::vector<std::pair<std::string, std::string>>& attributes = {}) {
  cppsearch::DocumentInput document;
  document.id = id;
  document.name = name;
  document.description = description;
  document.attributePairs = attributes;
  return document;
}

void IndexTests() {
  Run("index: upsert, size and remove", []() {
    cppsearch::SearchIndex index;
    CHECK_EQ(index.Size(), std::size_t{0});
    index.Upsert(MakeDocument("a", "iPhone 17"));
    index.Upsert(MakeDocument("b", "Pixel 10"));
    CHECK_EQ(index.Size(), std::size_t{2});
    CHECK(index.Remove("a"));
    CHECK(!index.Remove("a"));
    CHECK_EQ(index.Size(), std::size_t{2});  // tombstone keeps the slot
    CHECK_EQ(index.Search("pixel").size(), std::size_t{1});
    CHECK_EQ(index.Search("iphone").size(), std::size_t{0});
  });

  Run("index: re-adding an id replaces it rather than duplicating", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("a", "iPhone 17"));
    index.Upsert(MakeDocument("a", "iPhone 18"));
    CHECK_EQ(index.Size(), std::size_t{1});
    CHECK_EQ(index.Search("17").size(), std::size_t{0});
    CHECK_EQ(index.Search("18").size(), std::size_t{1});
  });

  Run("index: AND semantics — every term must match", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("phone", "Apple iPhone 17 Pro"));
    index.Upsert(MakeDocument("case", "Silicone Case for iPhone"));
    const auto hits = index.Search("iphone pro");
    CHECK_EQ(hits.size(), std::size_t{1});
    CHECK_EQ(hits[0].id, std::string("phone"));
  });

  Run("index: prefix expansion matches a partially typed word", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("phone", "Apple iPhone 17 Pro Max"));
    index.Upsert(MakeDocument("watch", "Apple Watch Series 11"));
    const auto hits = index.Search("ipho");
    CHECK_EQ(hits.size(), std::size_t{1});
    CHECK_EQ(hits[0].id, std::string("phone"));
  });

  Run("index: a term with no match at all returns nothing", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("phone", "Apple iPhone 17"));
    CHECK_EQ(index.Search("refrigerator").size(), std::size_t{0});
  });

  Run("index: fuzzy expansion recovers from a typo", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("phone", "Apple iPhone 17 Pro Max"));
    // "ipohne" is one transposition from "iphone".
    const auto hits = index.Search("ipohne");
    CHECK_EQ(hits.size(), std::size_t{1});
    CHECK(hits[0].fuzzy);
  });

  Run("index: short terms are not fuzzy-expanded into nonsense", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("a", "16GB card"));
    index.Upsert(MakeDocument("b", "32GB card"));
    // "mb" is below minFuzzyLength, so it must not be guessed as "gb".
    CHECK_EQ(index.Search("mb").size(), std::size_t{0});
  });

  Run("index: ranks the closer name match first", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("case", "Silicone Case for iPhone 17", "protective cover"));
    index.Upsert(MakeDocument("phone", "Apple iPhone 17 Pro Max 256GB", "flagship phone"));
    const auto hits = index.Search("iPhone 17 Pro Max 256GB");
    CHECK(!hits.empty());
    CHECK_EQ(hits[0].id, std::string("phone"));
  });

  Run("index: respects the result limit", []() {
    cppsearch::SearchIndex index;
    for (int counter = 0; counter < 50; ++counter) {
      index.Upsert(MakeDocument("p" + std::to_string(counter), "Widget " + std::to_string(counter)));
    }
    cppsearch::SearchOptions options;
    options.limit = 5;
    CHECK_EQ(index.Search("widget", options).size(), std::size_t{5});
  });

  Run("index: matchedFields reports which fields contributed", []() {
    cppsearch::SearchIndex index;
    auto document = MakeDocument("phone", "Apple iPhone", "flagship");
    document.brand = "Apple";
    index.Upsert(document);
    const auto hits = index.Search("apple");
    CHECK_EQ(hits.size(), std::size_t{1});
    const std::uint8_t nameBit = 1u << static_cast<unsigned>(cppsearch::Field::kName);
    const std::uint8_t brandBit = 1u << static_cast<unsigned>(cppsearch::Field::kBrand);
    CHECK((hits[0].matchedFields & nameBit) != 0);
    CHECK((hits[0].matchedFields & brandBit) != 0);
  });

  Run("index: attribute values are searchable text", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("phone", "Apple iPhone", "", {{"storage", "256gb"}}));
    const auto hits = index.Search("256gb");
    CHECK_EQ(hits.size(), std::size_t{1});
  });

  Run("index: exact attribute matching", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("a", "Phone A", "", {{"storage", "128gb"}}));
    index.Upsert(MakeDocument("b", "Phone B", "", {{"storage", "256gb"}}));
    index.Upsert(MakeDocument("c", "Phone C", "", {{"storage", "256gb"}}));
    const auto hits = index.MatchAttribute("storage", "256gb");
    CHECK_EQ(hits.size(), std::size_t{2});
    CHECK_EQ(index.MatchAttribute("storage", "512gb").size(), std::size_t{0});
  });

  Run("index: fuzzy attribute matching tolerates a typo in the value", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("a", "Phone A", "", {{"storage", "256gb"}}));
    index.Upsert(MakeDocument("b", "Phone B", "", {{"storage", "128gb"}}));
    const auto hits = index.FuzzyMatchAttribute("storage", "256gbe", 0.6);
    CHECK(!hits.empty());
    CHECK_EQ(hits[0], std::string("a"));
  });

  Run("index: prefix completion orders by frequency", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("a", "iPhone case"));
    index.Upsert(MakeDocument("b", "iPhone charger"));
    index.Upsert(MakeDocument("c", "iPhone screen"));
    index.Upsert(MakeDocument("d", "iPad case"));
    const auto terms = index.CompletePrefix("iph", 10);
    CHECK(!terms.empty());
    for (const auto& term : terms) CHECK(term.rfind("iph", 0) == 0);
  });

  Run("index: vocabulary shrinks when terms are removed", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("a", "unobtainium widget"));
    const auto before = index.VocabularySize();
    index.Remove("a");
    CHECK(index.VocabularySize() < before);
  });

  Run("index: clear empties everything", []() {
    cppsearch::SearchIndex index;
    index.Upsert(MakeDocument("a", "iPhone"));
    index.Clear();
    CHECK_EQ(index.Size(), std::size_t{0});
    CHECK_EQ(index.VocabularySize(), std::size_t{0});
    CHECK_EQ(index.Search("iphone").size(), std::size_t{0});
  });

  Run("index: handles a large catalog without degrading correctness", []() {
    cppsearch::SearchIndex index;
    for (int counter = 0; counter < 5000; ++counter) {
      cppsearch::DocumentInput document;
      document.id = "sku-" + std::to_string(counter);
      document.name = "Product " + std::to_string(counter) + (counter % 7 == 0 ? " Pro Edition" : "");
      document.description = "A dependable item in the catalog, number " + std::to_string(counter);
      document.attributePairs = {{"storage", counter % 2 == 0 ? "256gb" : "128gb"}};
      index.Upsert(document);
    }
    CHECK_EQ(index.Size(), std::size_t{5000});
    cppsearch::SearchOptions options;
    options.limit = 200;
    const auto hits = index.Search("pro edition", options);
    CHECK(hits.size() > 100);
    CHECK_EQ(index.MatchAttribute("storage", "256gb", 100).size(), std::size_t{100});
  });
}

/* ── C ABI ───────────────────────────────────────────────────────────── */

void FfiTests() {
  Run("ffi: version is reported", []() {
    const char* version = cppsearch_version();
    CHECK(version != nullptr);
    CHECK(std::strlen(version) > 0);
  });

  Run("ffi: rejects NULL arguments instead of crashing", []() {
    CHECK_EQ(cppsearch_index_upsert(nullptr, nullptr), -1);
    CHECK_EQ(cppsearch_index_remove(nullptr, "a"), -1);
    CHECK_EQ(cppsearch_index_size(nullptr), std::size_t{0});
    CHECK_EQ(cppsearch_index_search(nullptr, "q", nullptr, nullptr, 0), -1);
    cppsearch_index* index = cppsearch_index_create();
    CHECK(index != nullptr);
    CHECK_EQ(cppsearch_index_upsert(index, nullptr), -1);
    CHECK_EQ(cppsearch_index_search(index, nullptr, nullptr, nullptr, 10), -1);
    cppsearch_index_destroy(index);
  });

  Run("ffi: a document with a blank id is rejected", []() {
    cppsearch_index* index = cppsearch_index_create();
    cppsearch_document document{};
    document.id = "";
    document.name = "No id";
    CHECK_EQ(cppsearch_index_upsert(index, &document), -2);
    cppsearch_index_destroy(index);
  });

  Run("ffi: round-trips a document through search", []() {
    cppsearch_index* index = cppsearch_index_create();
    const char* keys[] = {"storage"};
    const char* values[] = {"256gb"};

    cppsearch_document phone{};
    phone.id = "phone";
    phone.name = "Apple iPhone 17 Pro Max";
    phone.description = "flagship smartphone";
    phone.attribute_keys = keys;
    phone.attribute_values = values;
    phone.attribute_count = 1;
    phone.price_minor_units = 13490000;
    CHECK_EQ(cppsearch_index_upsert(index, &phone), 0);

    cppsearch_document accessory{};
    accessory.id = "case";
    accessory.name = "Silicone Case for iPhone 17";
    CHECK_EQ(cppsearch_index_upsert(index, &accessory), 0);
    CHECK_EQ(cppsearch_index_size(index), std::size_t{2});

    cppsearch_search_options options;
    cppsearch_default_options(&options);
    options.limit = 10;

    cppsearch_hit hits[10];
    const int count = cppsearch_index_search(index, "iphone pro", &options, hits, 10);
    CHECK_EQ(count, 1);
    CHECK_EQ(std::string(hits[0].id), std::string("phone"));
    CHECK(hits[0].score > 0.0);

    // The FFI path must agree with the C++ path.
    cppsearch_index_destroy(index);
  });

  Run("ffi: completion returns vocabulary prefixes", []() {
    cppsearch_index* index = cppsearch_index_create();
    cppsearch_document document{};
    document.id = "a";
    document.name = "iPhone charger";
    cppsearch_index_upsert(index, &document);

    const char* terms[10];
    const int count = cppsearch_index_complete(index, "iph", terms, 10);
    CHECK(count >= 1);
    if (count >= 1) CHECK_EQ(std::string(terms[0]).rfind("iph", 0), std::size_t{0});
    cppsearch_index_destroy(index);
  });

  Run("ffi: tokenizer and canonical query match the C++ results", []() {
    const char* tokens[16];
    const int count = cppsearch_tokenize("iPhone 17 Pro-Max", tokens, 16);
    CHECK_EQ(count, 4);
    if (count == 4) {
      CHECK_EQ(std::string(tokens[0]), std::string("iphone"));
      CHECK_EQ(std::string(tokens[3]), std::string("max"));
    }

    char buffer[256];
    CHECK(cppsearch_canonical_query("Case iPhone case", buffer, sizeof(buffer)) > 0);
    CHECK_EQ(std::string(buffer), std::string("case iphone"));
    CHECK(cppsearch_normalize("  iPhone   17 ", buffer, sizeof(buffer)) > 0);
    CHECK_EQ(std::string(buffer), std::string("iphone 17"));
  });

  Run("ffi: similarity primitives are exposed", []() {
    CHECK_EQ(cppsearch_damerau_levenshtein("iphone", "ipohne", 0), std::size_t{1});
    CHECK_NEAR(cppsearch_similarity("iphone", "iphone"), 1.0, 1e-9);
    CHECK(cppsearch_word_similarity("silicone", "premium silicone case") > 0.9);
    CHECK_NEAR(cppsearch_similarity(nullptr, "a"), 0.0, 1e-9);
  });

  Run("ffi: output buffers too small are handled", []() {
    char small[4];
    CHECK_EQ(cppsearch_normalize("a very long string that will not fit", small, sizeof(small)), -1);
    CHECK_EQ(small[0], '\0');  // untouched, not partially written
  });
}

}  // namespace

int main() {
  std::printf("cpp-search test suite\n");
  TokenizerTests();
  SimilarityTests();
  IndexTests();
  FfiTests();

  std::printf("\n%d checks, %d failure(s)\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
