// Throughput benchmark for cpp-search.
//
// Exists so the "handles a large catalog" claim is measured rather than assumed.
// `make bench` reports indexing rate, search latency at several catalog sizes,
// and fuzzy-search cost (the expensive path, since it scans the vocabulary).

#include <chrono>
#include <cstdio>
#include <random>
#include <string>
#include <vector>

#include "cppsearch/index.h"

namespace {

using Clock = std::chrono::steady_clock;

double ElapsedMs(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

std::vector<cppsearch::DocumentInput> BuildCatalog(std::size_t count) {
  static const char* const kNouns[] = {"Shirt", "Hoodie", "Mug", "Poster", "Cap", "Tote", "Sticker",
                                       "Jacket", "Notebook", "Socks"};
  static const char* const kAdjectives[] = {"Classic", "Premium", "Organic", "Vintage", "Everyday",
                                            "Limited", "Recycled", "Heritage", "Signature", "Urban"};
  static const char* const kColors[] = {"black", "white", "navy", "olive", "sand", "rust", "ivory"};
  static const char* const kSizes[] = {"s", "m", "l", "xl", "2xl"};

  std::mt19937 random(20260607);  // fixed seed, so runs are comparable
  std::vector<cppsearch::DocumentInput> catalog;
  catalog.reserve(count);

  for (std::size_t index = 0; index < count; ++index) {
    cppsearch::DocumentInput document;
    document.id = "sku-" + std::to_string(index);
    document.name = std::string(kAdjectives[random() % 10]) + " " + kNouns[random() % 10] + " " +
                    std::to_string(index);
    document.brand = std::string(kAdjectives[random() % 10]) + " Supply Co";
    document.categoryPath = "apparel " + std::string(kNouns[random() % 10]);
    document.description = "Made to order with a soft hand feel. Ships within two business days.";
    document.tags = std::string(kColors[random() % 7]) + " gift unisex";
    document.attributePairs = {{
        "color", kColors[random() % 7]}, {"size", kSizes[random() % 5]}};
    document.priceMinorUnits = 49900 + static_cast<std::int64_t>(random() % 200000);
    document.popularity = static_cast<double>(random() % 100);
    document.rating = 3.0 + static_cast<double>(random() % 20) / 10.0;
    document.ratingCount = static_cast<std::int32_t>(random() % 500);
    catalog.push_back(std::move(document));
  }
  return catalog;
}

void RunAtScale(std::size_t count) {
  const auto catalog = BuildCatalog(count);

  cppsearch::SearchIndex index;
  const auto indexStart = Clock::now();
  for (const auto& document : catalog) index.Upsert(document);
  const double indexMs = ElapsedMs(indexStart);

  std::vector<const char*> queries = {"classic shirt", "premium hoodie", "vintage mug black",
                                      "organic", "heritage tote sand", "limited jacket xl"};

  cppsearch::SearchOptions options;
  options.limit = 20;

  const auto searchStart = Clock::now();
  std::size_t totalHits = 0;
  for (int pass = 0; pass < 20; ++pass) {
    for (const char* query : queries) totalHits += index.Search(query, options).size();
  }
  const double searchMs = ElapsedMs(searchStart);
  const int searchCount = 20 * static_cast<int>(queries.size());

  // Fuzzy path: no exact term, so the vocabulary is scanned.
  const auto fuzzyStart = Clock::now();
  std::size_t fuzzyHits = 0;
  for (int pass = 0; pass < 5; ++pass) {
    fuzzyHits += index.Search("clasic shrit", options).size();
    fuzzyHits += index.Search("premuim hodie", options).size();
  }
  const double fuzzyMs = ElapsedMs(fuzzyStart);

  const auto attributeStart = Clock::now();
  std::size_t attributeHits = 0;
  for (int pass = 0; pass < 100; ++pass) {
    attributeHits += index.MatchAttribute("color", "olive", 100).size();
  }
  const double attributeMs = ElapsedMs(attributeStart);

  std::printf("\n  catalog: %zu documents, %zu terms\n", index.Size(), index.VocabularySize());
  std::printf("  index build      %9.1f ms  (%.0f docs/s)\n", indexMs,
              static_cast<double>(count) / (indexMs / 1000.0));
  std::printf("  exact search     %9.3f ms/query over %d queries (%zu hits)\n",
              searchMs / static_cast<double>(searchCount), searchCount, totalHits);
  std::printf("  fuzzy search     %9.3f ms/query over 10 queries (%zu hits)\n", fuzzyMs / 10.0,
              fuzzyHits);
  std::printf("  attribute match  %9.4f ms/query over 100 queries (%zu hits)\n", attributeMs / 100.0,
              attributeHits);
}

}  // namespace

int main(int argc, char** argv) {
  const std::size_t count = argc > 1 ? static_cast<std::size_t>(std::atol(argv[1])) : 50000;
  std::printf("cpp-search benchmark\n");
  RunAtScale(count);
  return 0;
}
