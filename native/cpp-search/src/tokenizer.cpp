#include "cppsearch/tokenizer.h"

#include <algorithm>
#include <array>
#include <cctype>

namespace cppsearch {

std::uint32_t DecodeUtf8(std::string_view text, std::size_t& pos) {
  if (pos >= text.size()) return 0;
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
    // Not a valid lead byte: consume one byte and signal "drop".
    ++pos;
    return 0;
  }

  if (pos + length > text.size()) {
    ++pos;
    return 0;
  }
  for (std::size_t offset = 1; offset < length; ++offset) {
    const auto byte = static_cast<unsigned char>(text[pos + offset]);
    if (!IsUtf8Continuation(byte)) {
      ++pos;
      return 0;
    }
    codePoint = (codePoint << 6) | (byte & 0x3Fu);
  }
  pos += length;
  return codePoint;
}

void AppendUtf8(std::string& out, std::uint32_t codePoint) {
  if (codePoint < 0x80u) {
    out.push_back(static_cast<char>(codePoint));
  } else if (codePoint < 0x800u) {
    out.push_back(static_cast<char>(0xC0u | (codePoint >> 6)));
    out.push_back(static_cast<char>(0x80u | (codePoint & 0x3Fu)));
  } else if (codePoint < 0x10000u) {
    out.push_back(static_cast<char>(0xE0u | (codePoint >> 12)));
    out.push_back(static_cast<char>(0x80u | ((codePoint >> 6) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | (codePoint & 0x3Fu)));
  } else {
    out.push_back(static_cast<char>(0xF0u | (codePoint >> 18)));
    out.push_back(static_cast<char>(0x80u | ((codePoint >> 12) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | ((codePoint >> 6) & 0x3Fu)));
    out.push_back(static_cast<char>(0x80u | (codePoint & 0x3Fu)));
  }
}

std::uint32_t FoldCodePoint(std::uint32_t codePoint) {
  // Combining diacritical marks: dropped, which is what turns "cafe\u0301" into
  // "cafe". Matches the TS `.replace(/[\u0300-\u036f]/g, "")` step.
  if (codePoint >= 0x0300u && codePoint <= 0x036Fu) return 0;

  if (codePoint < 0x80u) {
    return static_cast<std::uint32_t>(
        std::tolower(static_cast<unsigned char>(codePoint)));
  }

  // Precomposed Latin letters that matter for product names. A full Unicode
  // casefold is not worth the table; these cover the realistic catalog input.
  static const std::array<std::pair<std::uint32_t, std::uint32_t>, 60> kSpecialFolds = {{
      {0x00C0u, 'a'}, {0x00C1u, 'a'}, {0x00C2u, 'a'}, {0x00C3u, 'a'}, {0x00C4u, 'a'},
      {0x00C5u, 'a'}, {0x00C7u, 'c'}, {0x00C8u, 'e'}, {0x00C9u, 'e'}, {0x00CAu, 'e'},
      {0x00CBu, 'e'}, {0x00CCu, 'i'}, {0x00CDu, 'i'}, {0x00CEu, 'i'}, {0x00CFu, 'i'},
      {0x00D1u, 'n'}, {0x00D2u, 'o'}, {0x00D3u, 'o'}, {0x00D4u, 'o'}, {0x00D5u, 'o'},
      {0x00D6u, 'o'}, {0x00D9u, 'u'}, {0x00DAu, 'u'}, {0x00DBu, 'u'}, {0x00DCu, 'u'},
      {0x00DDu, 'y'}, {0x00E0u, 'a'}, {0x00E1u, 'a'}, {0x00E2u, 'a'}, {0x00E3u, 'a'},
      {0x00E4u, 'a'}, {0x00E5u, 'a'}, {0x00E7u, 'c'}, {0x00E8u, 'e'}, {0x00E9u, 'e'},
      {0x00EAu, 'e'}, {0x00EBu, 'e'}, {0x00ECu, 'i'}, {0x00EDu, 'i'}, {0x00EEu, 'i'},
      {0x00EFu, 'i'}, {0x00F1u, 'n'}, {0x00F2u, 'o'}, {0x00F3u, 'o'}, {0x00F4u, 'o'},
      {0x00F5u, 'o'}, {0x00F6u, 'o'}, {0x00F9u, 'u'}, {0x00FAu, 'u'}, {0x00FBu, 'u'},
      {0x00FCu, 'u'}, {0x00FDu, 'y'}, {0x00FFu, 'y'}, {0x0100u, 'a'}, {0x0101u, 'a'},
      {0x0141u, 'l'}, {0x0142u, 'l'}, {0x0152u, 'o'}, {0x0153u, 'o'}, {0x00DFu, 's'},
  }};
  for (const auto& fold : kSpecialFolds) {
    if (fold.first == codePoint) return fold.second;
  }

  // Cyrillic and Greek lowercase (common enough in a global catalog to be worth
  // handling; uppercase simply maps into the lowercase block).
  if (codePoint >= 0x0410u && codePoint <= 0x042Fu) return codePoint + 0x20u;
  if (codePoint >= 0x0391u && codePoint <= 0x03A9u) return codePoint + 0x20u;

  return codePoint;
}

bool IsWordCodePoint(std::uint32_t codePoint) {
  if (codePoint >= 'a' && codePoint <= 'z') return true;
  if (codePoint >= '0' && codePoint <= '9') return true;
  if (codePoint >= 0x80u && codePoint <= 0x024Fu) return true;   // Latin extended
  if (codePoint >= 0x0370u && codePoint <= 0x052Fu) return true; // Greek + Cyrillic
  if (codePoint >= 0x0590u && codePoint <= 0x06FFu) return true; // Hebrew + Arabic
  if (codePoint >= 0x0900u && codePoint <= 0x0D7Fu) return true; // Indic scripts
  if (codePoint >= 0x3040u && codePoint <= 0x30FFu) return true; // Japanese kana
  if (codePoint >= 0x4E00u && codePoint <= 0x9FFFu) return true; // CJK
  if (codePoint >= 0xAC00u && codePoint <= 0xD7AFu) return true; // Hangul
  return false;
}

std::string Normalize(std::string_view text) {
  std::string out;
  out.reserve(text.size());
  std::size_t pos = 0;
  bool pendingSpace = false;

  while (pos < text.size()) {
    const std::uint32_t raw = DecodeUtf8(text, pos);
    const std::uint32_t folded = FoldCodePoint(raw);
    if (folded == 0) continue;  // combining mark or invalid byte
    if (!IsWordCodePoint(folded)) {
      pendingSpace = !out.empty();
      continue;
    }
    if (pendingSpace) {
      out.push_back(' ');
      pendingSpace = false;
    }
    AppendUtf8(out, folded);
  }
  return out;
}

std::vector<std::string> Tokenize(std::string_view text, std::size_t maxTokens) {
  std::vector<std::string> tokens;
  std::string current;
  current.reserve(kMaxTokenLength);

  const auto flush = [&]() {
    if (current.empty()) return;
    if (maxTokens == 0 || tokens.size() < maxTokens) tokens.push_back(current);
    current.clear();
  };

  std::size_t pos = 0;
  while (pos < text.size()) {
    const std::uint32_t raw = DecodeUtf8(text, pos);
    const std::uint32_t folded = FoldCodePoint(raw);
    // Combining marks attach to the token currently being built, so they are
    // skipped without terminating it.
    if (folded == 0) continue;
    if (!IsWordCodePoint(folded)) {
      flush();
      continue;
    }
    if (current.size() < kMaxTokenLength) AppendUtf8(current, folded);
  }
  flush();

  if (maxTokens > 0 && tokens.size() > maxTokens) tokens.resize(maxTokens);
  return tokens;
}

std::string SanitizeQuery(std::string_view raw, std::size_t maxLength) {
  std::string out;
  out.reserve(std::min(raw.size(), maxLength));
  bool pendingSpace = false;

  for (const char character : raw) {
    const auto byte = static_cast<unsigned char>(character);
    const bool isControl = byte < 0x20u || byte == 0x7Fu;
    if (isControl || byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r') {
      pendingSpace = !out.empty();
      continue;
    }
    if (pendingSpace) {
      if (out.size() + 1 > maxLength) break;
      out.push_back(' ');
      pendingSpace = false;
    }
    if (out.size() >= maxLength) break;
    out.push_back(character);
  }
  return out;
}

std::string CanonicalQuery(std::string_view raw) {
  auto tokens = Tokenize(SanitizeQuery(raw));
  std::sort(tokens.begin(), tokens.end());
  tokens.erase(std::unique(tokens.begin(), tokens.end()), tokens.end());

  std::string out;
  for (std::size_t index = 0; index < tokens.size(); ++index) {
    if (index > 0) out.push_back(' ');
    out += tokens[index];
  }
  return out;
}

}  // namespace cppsearch
