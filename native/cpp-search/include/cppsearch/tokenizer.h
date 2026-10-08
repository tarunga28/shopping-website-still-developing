#pragma once
// Tokenizer for the catalog search engine.
//
// This MUST stay in lockstep with `src/lib/catalog/search-text.ts` in the
// TypeScript codebase: both sides normalize and split text the same way, so a
// document indexed by one is found by the other. `tests/test_main.cpp` pins the
// behaviour and `tests/unit/search-text.test.ts` pins the TypeScript twin.
//
// Rules:
//   1. UTF-8 aware, ASCII fast path.
//   2. Strip combining marks so "café" folds to "cafe" (matches the TS NFKD
//      + strip-diacritics step).
//   3. Lowercase.
//   4. Split on any run of characters that is neither a letter nor a digit.

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace cppsearch {

/** Longest token retained. Longer runs are noise, not search terms. */
inline constexpr std::size_t kMaxTokenLength = 64;

/** True when the byte starts a UTF-8 continuation (10xxxxxx). */
inline bool IsUtf8Continuation(unsigned char byte) { return (byte & 0xC0u) == 0x80u; }

/** Decode one code point at `pos`, advancing it. Returns 0 on malformed input. */
std::uint32_t DecodeUtf8(std::string_view text, std::size_t& pos);

/** Append `codePoint` to `out` as UTF-8. */
void AppendUtf8(std::string& out, std::uint32_t codePoint);

/**
 * Fold one code point: strip combining marks, casefold ASCII, and map the few
 * Latin-1 letters that matter for product names.
 *
 * Returns 0 when the code point should be dropped entirely (a combining mark).
 */
std::uint32_t FoldCodePoint(std::uint32_t codePoint);

/** Is this code point a letter or digit? Unicode ranges cover the common scripts. */
bool IsWordCodePoint(std::uint32_t codePoint);

/**
 * Normalize text: fold and collapse, without splitting.
 * Used to build the trigram comparison text.
 */
std::string Normalize(std::string_view text);

/**
 * Tokenize text into folded terms.
 *
 * `maxTokens` bounds the work a caller can force with a huge product
 * description; pass 0 for unlimited.
 */
std::vector<std::string> Tokenize(std::string_view text, std::size_t maxTokens = 0);

/**
 * Sanitize a user query the same way `sanitizeQuery` does in TypeScript:
 * drop control characters, collapse whitespace, bound the length.
 */
std::string SanitizeQuery(std::string_view raw, std::size_t maxLength = 80);

/**
 * Canonical form used for query logging and cache keys: tokens deduplicated and
 * sorted, so "iphone case" and "case iphone" collapse to one key.
 */
std::string CanonicalQuery(std::string_view raw);

}  // namespace cppsearch
