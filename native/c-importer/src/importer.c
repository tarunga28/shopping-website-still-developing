/*
 * c-importer implementation. See importer.h for the contract.
 *
 * Two invariants worth protecting:
 *   1. Nothing is allocated per row. The parser owns one field-pointer array
 *      and one text buffer, both reused, so importing 500k rows costs the same
 *      memory as importing 50.
 *   2. Quoted fields are handled per RFC 4180: a doubled quote inside a quoted
 *      field is a literal quote, and a quoted field may contain the delimiter
 *      and newlines. Supplier exports always contain one product description
 *      with a comma in it.
 */

#include "importer.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

/* Generous upper bound on columns; a wider file is a data problem, not a
 * feature request. */
#define IMP_MAX_COLUMNS 256

/* Number of preallocated text slots, so common rows need no reallocation. */
#define IMP_INITIAL_FIELD_CAPACITY 64

struct imp_parser {
  const char* data;
  size_t length;
  size_t offset;
  char delimiter;
  size_t line_number;

  /* Reused row storage. */
  char** field_pointers;
  size_t field_capacity;
  char* scratch;
  size_t scratch_capacity;

  /* Column count from the header, used to flag ragged rows. */
  size_t header_column_count;
  int header_read;

  /* SKUs already seen in this file. A tiny open-addressed set: the goal is to
   * catch an accidental duplicate line, not to be a general-purpose hash map. */
  char** seen_skus;
  size_t seen_capacity;
  size_t seen_count;
};

/* ── small helpers ─────────────────────────────────────────────────────── */

static int ascii_equal_ignore_case(const char* a, const char* b) {
  while (*a && *b) {
    if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
    ++a;
    ++b;
  }
  return *a == '\0' && *b == '\0';
}

/* Trim ASCII whitespace and UTF-8 BOM from both ends, in place. */
static char* trim_in_place(char* value) {
  char* start = value;
  /* Skip a BOM at the start of the file — Excel writes one and it otherwise
   * becomes part of the first column name. */
  if ((unsigned char)start[0] == 0xEF && (unsigned char)start[1] == 0xBB &&
      (unsigned char)start[2] == 0xBF) {
    start += 3;
  }
  while (*start && isspace((unsigned char)*start)) ++start;

  char* end = start + strlen(start);
  while (end > start && isspace((unsigned char)end[-1])) --end;
  *end = '\0';
  return start;
}

static int ensure_field_capacity(imp_parser* parser, size_t needed) {
  if (needed <= parser->field_capacity) return IMP_OK;

  size_t capacity = parser->field_capacity > 0 ? parser->field_capacity : IMP_INITIAL_FIELD_CAPACITY;
  while (capacity < needed) capacity *= 2;

  char** grown = (char**)realloc(parser->field_pointers, capacity * sizeof(char*));
  if (grown == NULL) return IMP_ERR_ALLOC;
  parser->field_pointers = grown;
  parser->field_capacity = capacity;
  return IMP_OK;
}

static int ensure_scratch_capacity(imp_parser* parser, size_t needed) {
  if (needed <= parser->scratch_capacity) return IMP_OK;

  /* The scratch buffer holds one row at a time, so the ceiling is the row cap —
   * not the row cap plus the quoted-field cap, which would let a single
   * oversized field through. */
  if (needed > IMP_MAX_ROW_BYTES) return IMP_ERR_TOO_LARGE;

  size_t capacity = parser->scratch_capacity > 0 ? parser->scratch_capacity : 4096;
  while (capacity < needed) capacity *= 2;

  char* grown = (char*)realloc(parser->scratch, capacity);
  if (grown == NULL) return IMP_ERR_ALLOC;
  parser->scratch = grown;
  parser->scratch_capacity = capacity;
  return IMP_OK;
}

/* ── parser lifecycle ──────────────────────────────────────────────────── */

imp_parser* imp_parser_create(const char* data, size_t length, char delimiter) {
  if (data == NULL || delimiter == '\0') return NULL;

  imp_parser* parser = (imp_parser*)calloc(1, sizeof(imp_parser));
  if (parser == NULL) return NULL;

  parser->data = data;
  parser->length = length;
  parser->offset = 0;
  parser->delimiter = delimiter;
  parser->line_number = 1;

  if (ensure_field_capacity(parser, IMP_INITIAL_FIELD_CAPACITY) != IMP_OK ||
      ensure_scratch_capacity(parser, 8192) != IMP_OK) {
    imp_parser_free(parser);
    return NULL;
  }
  return parser;
}

void imp_parser_free(imp_parser* parser) {
  if (parser == NULL) return;
  free(parser->field_pointers);
  free(parser->scratch);
  if (parser->seen_skus != NULL) {
    for (size_t index = 0; index < parser->seen_capacity; ++index) free(parser->seen_skus[index]);
    free(parser->seen_skus);
  }
  free(parser);
}

/* ── field parsing ─────────────────────────────────────────────────────── */

/*
 * Parse one row starting at parser->offset.
 *
 * Returns 1 when a row was produced, 0 at end of input, negative on error.
 * Blank lines are skipped, because every supplier file ends with one.
 */
static int parse_row(imp_parser* parser, imp_row* out_row) {
  size_t field_count = 0;
  /* Where the current field's text starts inside the scratch buffer. */
  size_t scratch_used = 0;

  /* Skip blank lines without counting them as data. */
  while (parser->offset < parser->length &&
         (parser->data[parser->offset] == '\r' || parser->data[parser->offset] == '\n')) {
    if (parser->data[parser->offset] == '\n') ++parser->line_number;
    ++parser->offset;
  }
  if (parser->offset >= parser->length) return 0;

  const size_t row_line = parser->line_number;
  int row_complete = 0;

  while (!row_complete) {
    int quoted = 0;
    size_t field_start = scratch_used;
    /* Bytes written to the field being built, used to enforce the per-field
     * caps. Bounding only the whole row would let one oversized field through. */
    size_t field_bytes = 0;

    /* A field may be quoted, in which case it can contain the delimiter and
     * newlines, and "" means a literal quote. */
    if (parser->offset < parser->length && parser->data[parser->offset] == '"') {
      quoted = 1;
      ++parser->offset;
    }

    for (;;) {
      if (parser->offset >= parser->length) {
        row_complete = 1;
        break;
      }

      const char current = parser->data[parser->offset];

      if (quoted) {
        if (current == '"') {
          if (parser->offset + 1 < parser->length && parser->data[parser->offset + 1] == '"') {
            /* Escaped quote: emit one, consume both. */
            if (++field_bytes > IMP_MAX_QUOTED_FIELD_BYTES) return IMP_ERR_TOO_LARGE;
            if (ensure_scratch_capacity(parser, scratch_used + 1) != IMP_OK) return IMP_ERR_TOO_LARGE;
            parser->scratch[scratch_used++] = '"';
            parser->offset += 2;
            continue;
          }
          /* Closing quote. Anything after it before the delimiter is junk we
           * skip rather than fail on — supplier files are full of it. */
          ++parser->offset;
          quoted = 0;
          continue;
        }
        if (++field_bytes > IMP_MAX_QUOTED_FIELD_BYTES) return IMP_ERR_TOO_LARGE;
        if (ensure_scratch_capacity(parser, scratch_used + 1) != IMP_OK) return IMP_ERR_TOO_LARGE;
        parser->scratch[scratch_used++] = current;
        if (current == '\n') ++parser->line_number;
        ++parser->offset;
        continue;
      }

      if (current == parser->delimiter) {
        ++parser->offset;
        break;  /* end of this field, more to come */
      }
      if (current == '\n') {
        ++parser->offset;
        ++parser->line_number;
        row_complete = 1;
        break;
      }
      if (current == '\r') {
        /* CRLF: consume both without double-counting the line. */
        if (parser->offset + 1 < parser->length && parser->data[parser->offset + 1] == '\n') {
          parser->offset += 2;
        } else {
          ++parser->offset;
        }
        ++parser->line_number;
        row_complete = 1;
        break;
      }

      if (++field_bytes > IMP_MAX_FIELD_BYTES) return IMP_ERR_TOO_LARGE;
      if (ensure_scratch_capacity(parser, scratch_used + 1) != IMP_OK) return IMP_ERR_TOO_LARGE;
      parser->scratch[scratch_used++] = current;
      ++parser->offset;
    }

    /* Terminate the field and record its pointer. */
    if (ensure_scratch_capacity(parser, scratch_used + 1) != IMP_OK) return IMP_ERR_TOO_LARGE;
    parser->scratch[scratch_used] = '\0';
    ++scratch_used;

    if (ensure_field_capacity(parser, field_count + 1) != IMP_OK) return IMP_ERR_ALLOC;
    parser->field_pointers[field_count++] = parser->scratch + field_start;

    if (field_count > IMP_MAX_COLUMNS) return IMP_ERR_TOO_LARGE;
  }

  out_row->fields = (const char* const*)parser->field_pointers;
  out_row->field_count = field_count;
  out_row->line_number = row_line;
  return 1;
}

int imp_read_header(imp_parser* parser, const char** out_columns, size_t capacity) {
  if (parser == NULL || out_columns == NULL || capacity == 0) return IMP_ERR_NULL_ARG;

  imp_row row;
  const int result = parse_row(parser, &row);
  if (result < 0) return result;
  if (result == 0) return IMP_ERR_NO_HEADER;

  const size_t count = row.field_count < capacity ? row.field_count : capacity;
  for (size_t index = 0; index < count; ++index) {
    out_columns[index] = trim_in_place((char*)row.fields[index]);
  }
  parser->header_column_count = row.field_count;
  parser->header_read = 1;
  return (int)row.field_count;
}

int imp_next_row(imp_parser* parser, imp_row* out_row) {
  if (parser == NULL || out_row == NULL) return IMP_ERR_NULL_ARG;
  return parse_row(parser, out_row);
}

/* ── column mapping ────────────────────────────────────────────────────── */

/* Each entry: the canonical column, then the spellings suppliers actually use.
 * Matching is case-insensitive and exact-after-trim, deliberately not fuzzy —
 * guessing which column is the price is how catalogs get silently corrupted. */
static int find_column(const char* const* columns, size_t column_count, const char* const* aliases) {
  for (size_t alias = 0; aliases[alias] != NULL; ++alias) {
    for (size_t index = 0; index < column_count; ++index) {
      if (columns[index] != NULL && ascii_equal_ignore_case(columns[index], aliases[alias])) {
        return (int)index;
      }
    }
  }
  return -1;
}

int imp_map_columns(const char* const* columns, size_t column_count, imp_column_map* out_map) {
  if (columns == NULL || out_map == NULL) return IMP_ERR_NULL_ARG;

  static const char* const kName[] = {"name", "product name", "title", "product title", "item name",
                                      "product", NULL};
  static const char* const kSku[] = {"sku", "item number", "item no", "product sku", "article number",
                                     "article no", "code", "product code", NULL};
  static const char* const kPrice[] = {"price", "unit price", "base price", "regular price", "mrp",
                                       "retail price", "list price", NULL};
  static const char* const kSalePrice[] = {"sale price", "saleprice", "discounted price", "offer price",
                                           "special price", "selling price", NULL};
  static const char* const kStock[] = {"stock", "stock quantity", "quantity", "qty", "inventory",
                                       "available stock", "stock qty", NULL};
  static const char* const kImageUrl[] = {"image", "image url", "image_url", "main image",
                                          "primary image", "photo", "photo url", NULL};
  static const char* const kEmail[] = {"email", "e-mail", "contact email", "supplier email", NULL};

  out_map->name = find_column(columns, column_count, kName);
  out_map->sku = find_column(columns, column_count, kSku);
  out_map->price = find_column(columns, column_count, kPrice);
  out_map->sale_price = find_column(columns, column_count, kSalePrice);
  out_map->stock = find_column(columns, column_count, kStock);
  out_map->image_url = find_column(columns, column_count, kImageUrl);
  out_map->email = find_column(columns, column_count, kEmail);
  return IMP_OK;
}

/* ── field validators ──────────────────────────────────────────────────── */

int imp_is_valid_sku(const char* value) {
  if (value == NULL) return 0;
  size_t length = strlen(value);
  if (length < 3 || length > 64) return 0;
  for (size_t index = 0; index < length; ++index) {
    const char character = value[index];
    const int allowed = (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') ||
                        character == '-' || character == '_';
    if (!allowed) return 0;
  }
  return 1;
}

size_t imp_normalize_sku(char* value) {
  if (value == NULL) return 0;
  char* trimmed = trim_in_place(value);
  if (trimmed != value) memmove(value, trimmed, strlen(trimmed) + 1);
  for (char* cursor = value; *cursor != '\0'; ++cursor) {
    *cursor = (char)toupper((unsigned char)*cursor);
  }
  return strlen(value);
}

int imp_is_valid_amount(const char* value) {
  if (value == NULL || *value == '\0') return 0;

  const char* cursor = value;
  /* Tolerate a leading currency symbol; supplier sheets always have one. */
  if (*cursor == '\xe2' && cursor[1] == '\x82' && cursor[2] == '\xb9') {
    cursor += 3; /* U+20B9 INR */
  } else if (*cursor == '$' || *cursor == '\xc2' /* first byte of U+00A3/U+20AC */) {
    ++cursor;
    if ((unsigned char)value[0] == 0xC2) ++cursor;
  }

  int digits_before_dot = 0;
  int digits_after_dot = 0;
  int seen_dot = 0;

  for (; *cursor != '\0'; ++cursor) {
    if (*cursor == ',') continue;  /* thousands separator */
    if (*cursor == '.') {
      if (seen_dot) return 0;  /* two decimal points is not a number */
      seen_dot = 1;
      continue;
    }
    if (*cursor < '0' || *cursor > '9') return 0;
    if (seen_dot) {
      ++digits_after_dot;
    } else {
      ++digits_before_dot;
    }
  }
  if (digits_before_dot == 0) return 0;
  /* More than two decimal places cannot be expressed in minor units without
   * silently losing money, so reject rather than round. */
  if (digits_after_dot > 2) return 0;
  return 1;
}

int imp_parse_amount_minor(const char* value, int64_t* out_minor_units) {
  if (out_minor_units == NULL) return IMP_ERR_NULL_ARG;
  if (!imp_is_valid_amount(value)) return -10;

  const char* cursor = value;
  if (*cursor == '\xe2' && cursor[1] == '\x82' && cursor[2] == '\xb9') {
    cursor += 3;
  } else if (*cursor == '$') {
    ++cursor;
  } else if ((unsigned char)cursor[0] == 0xC2) {
    cursor += 2;
  }

  int64_t whole = 0;
  int64_t fraction = 0;
  int fraction_digits = 0;
  int seen_dot = 0;

  for (; *cursor != '\0'; ++cursor) {
    if (*cursor == ',') continue;
    if (*cursor == '.') {
      seen_dot = 1;
      continue;
    }
    const int digit = *cursor - '0';
    if (!seen_dot) {
      whole = whole * 10 + digit;
    } else if (fraction_digits < 2) {
      fraction = fraction * 10 + digit;
      ++fraction_digits;
    }
  }
  /* "19.5" means 19.50, not 19.05 — pad the fraction out to two places. */
  while (fraction_digits < 2) {
    fraction *= 10;
    ++fraction_digits;
  }

  *out_minor_units = whole * 100 + fraction;
  return IMP_OK;
}

int imp_is_valid_non_negative_int(const char* value) {
  if (value == NULL || *value == '\0') return 0;
  int digits = 0;
  for (const char* cursor = value; *cursor != '\0'; ++cursor) {
    if (*cursor == ',') continue;
    if (*cursor < '0' || *cursor > '9') return 0;
    ++digits;
  }
  return digits > 0;
}

int imp_is_valid_http_url(const char* value) {
  if (value == NULL) return 0;
  const char* cursor = value;

  if (strncmp(cursor, "https://", 8) == 0) {
    cursor += 8;
  } else if (strncmp(cursor, "http://", 7) == 0) {
    cursor += 7;
  } else {
    return 0;  /* relative or scheme-less URLs are not object-storage addresses */
  }

  /* Must have a host, and the host must contain a dot. */
  size_t host_length = 0;
  int seen_dot = 0;
  while (*cursor != '\0' && *cursor != '/' && *cursor != '?' && *cursor != '#') {
    if (*cursor == '.') seen_dot = 1;
    if (isspace((unsigned char)*cursor)) return 0;
    ++host_length;
    ++cursor;
  }
  if (host_length < 4 || !seen_dot) return 0;
  return 1;
}

int imp_is_valid_email(const char* value) {
  if (value == NULL) return 0;
  const char* at = strchr(value, '@');
  if (at == NULL || at == value) return 0;
  if (strchr(at + 1, '@') != NULL) return 0;  /* exactly one '@' */
  if (at[1] == '\0') return 0;
  if (strchr(at + 1, '.') == NULL) return 0;
  if (isspace((unsigned char)value[0])) return 0;
  return 1;
}

/* ── row validation ────────────────────────────────────────────────────── */

static const char* issue_message(imp_issue_kind kind) {
  switch (kind) {
    case IMP_ISSUE_MISSING_REQUIRED: return "required column is missing from the file header";
    case IMP_ISSUE_EMPTY_NAME: return "product name is empty";
    case IMP_ISSUE_BAD_SKU: return "SKU must be 3-64 characters of A-Z, 0-9, '-' or '_'";
    case IMP_ISSUE_DUPLICATE_SKU: return "SKU appears more than once in this file";
    case IMP_ISSUE_NEGATIVE_PRICE: return "price must not be negative";
    case IMP_ISSUE_BAD_NUMBER: return "value is not a valid number";
    case IMP_ISSUE_FIELD_COUNT_MISMATCH: return "row has a different number of columns than the header";
    case IMP_ISSUE_BAD_URL: return "image URL must be an absolute http(s) address";
    case IMP_ISSUE_BAD_EMAIL: return "email address is not valid";
    case IMP_ISSUE_ROW_TOO_LARGE: return "row exceeds the maximum size";
    default: return "unknown problem";
  }
}

int imp_validate_row(const imp_row* row, const imp_column_map* map, imp_issue* out_issues,
                     size_t capacity) {
  if (row == NULL || map == NULL || (out_issues == NULL && capacity > 0)) return IMP_ERR_NULL_ARG;

  size_t found = 0;
  const size_t limit = out_issues != NULL ? capacity : 0;

  /* Report every problem in a row rather than stopping at the first: whoever
   * cleans the file can then fix the whole line in one pass. */
  /* Parameter names are suffixed with an underscore because `kind` and
   * `field_index` are also imp_issue member names — a macro substitutes its
   * parameters everywhere, including inside `.kind`, which produces nonsense. */
  #define RECORD(issue_kind_, issue_field_)                            \
    do {                                                               \
      if (found < limit) {                                             \
        out_issues[found].kind = (issue_kind_);                        \
        out_issues[found].field_index = (issue_field_);                \
        out_issues[found].message = issue_message(issue_kind_);        \
      }                                                                \
      ++found;                                                         \
    } while (0)

  const char* field_at = NULL;
  #define FIELD(index) ((index) >= 0 && (size_t)(index) < row->field_count ? row->fields[(index)] : NULL)

  if (map->name < 0) {
    RECORD(IMP_ISSUE_MISSING_REQUIRED, SIZE_MAX);
  } else {
    field_at = FIELD(map->name);
    if (field_at == NULL || field_at[0] == '\0') RECORD(IMP_ISSUE_EMPTY_NAME, (size_t)map->name);
  }

  if (map->sku >= 0) {
    field_at = FIELD(map->sku);
    if (field_at != NULL && field_at[0] != '\0' && !imp_is_valid_sku(field_at)) {
      RECORD(IMP_ISSUE_BAD_SKU, (size_t)map->sku);
    }
  }

  if (map->price >= 0) {
    field_at = FIELD(map->price);
    if (field_at != NULL && field_at[0] != '\0' && !imp_is_valid_amount(field_at)) {
      RECORD(IMP_ISSUE_BAD_NUMBER, (size_t)map->price);
    }
  }

  if (map->sale_price >= 0) {
    field_at = FIELD(map->sale_price);
    if (field_at != NULL && field_at[0] != '\0' && !imp_is_valid_amount(field_at)) {
      RECORD(IMP_ISSUE_BAD_NUMBER, (size_t)map->sale_price);
    }
  }

  if (map->stock >= 0) {
    field_at = FIELD(map->stock);
    if (field_at != NULL && field_at[0] != '\0' && !imp_is_valid_non_negative_int(field_at)) {
      RECORD(IMP_ISSUE_BAD_NUMBER, (size_t)map->stock);
    }
  }

  if (map->image_url >= 0) {
    field_at = FIELD(map->image_url);
    if (field_at != NULL && field_at[0] != '\0' && !imp_is_valid_http_url(field_at)) {
      RECORD(IMP_ISSUE_BAD_URL, (size_t)map->image_url);
    }
  }

  if (map->email >= 0) {
    field_at = FIELD(map->email);
    if (field_at != NULL && field_at[0] != '\0' && !imp_is_valid_email(field_at)) {
      RECORD(IMP_ISSUE_BAD_EMAIL, (size_t)map->email);
    }
  }

  (void)field_at;
  return (int)found;

  #undef FIELD
  #undef RECORD
}

/* ── in-file duplicate detection ───────────────────────────────────────── */

static size_t hash_sku(const char* value) {
  /* FNV-1a: cheap, and good enough for a bounded dedupe set. */
  size_t hash = 1469598103934665603ULL;
  for (const char* cursor = value; *cursor != '\0'; ++cursor) {
    hash ^= (size_t)(unsigned char)*cursor;
    hash *= 1099511628211ULL;
  }
  return hash;
}

int imp_note_sku(imp_parser* parser, const char* sku, size_t max_entries) {
  if (parser == NULL || sku == NULL) return IMP_ERR_NULL_ARG;
  if (sku[0] == '\0') return IMP_ERR_NULL_ARG;

  if (parser->seen_capacity == 0) {
    /* Start small; most files have no duplicates at all and should not pay for
     * a large table. */
    parser->seen_capacity = 1024;
    parser->seen_skus = (char**)calloc(parser->seen_capacity, sizeof(char*));
    if (parser->seen_skus == NULL) {
      parser->seen_capacity = 0;
      return IMP_ERR_ALLOC;
    }
  }

  /* Stop growing past the caller's bound instead of risking OOM on a corrupt
   * or hostile multi-gigabyte file. Past this point duplicates go unreported,
   * which is the lesser failure. */
  if (parser->seen_count >= max_entries) return 0;

  /* Linear probing degrades badly as the table fills, and past a load factor of
   * 1 it cannot insert at all. Grow at 70% so lookup stays near O(1). */
  if ((parser->seen_count + 1) * 10 > parser->seen_capacity * 7) {
    const size_t new_capacity = parser->seen_capacity * 2;
    char** grown = (char**)calloc(new_capacity, sizeof(char*));
    if (grown == NULL) return IMP_ERR_ALLOC;

    for (size_t index = 0; index < parser->seen_capacity; ++index) {
      if (parser->seen_skus[index] == NULL) continue;
      size_t slot = hash_sku(parser->seen_skus[index]) % new_capacity;
      while (grown[slot] != NULL) slot = (slot + 1) % new_capacity;
      grown[slot] = parser->seen_skus[index];
    }
    free(parser->seen_skus);
    parser->seen_skus = grown;
    parser->seen_capacity = new_capacity;
  }

  size_t slot = hash_sku(sku) % parser->seen_capacity;
  while (parser->seen_skus[slot] != NULL) {
    if (strcmp(parser->seen_skus[slot], sku) == 0) return 1;
    slot = (slot + 1) % parser->seen_capacity;
  }

  const size_t needed = strlen(sku) + 1;
  char* copy = (char*)malloc(needed);
  if (copy == NULL) return IMP_ERR_ALLOC;
  memcpy(copy, sku, needed);
  parser->seen_skus[slot] = copy;
  ++parser->seen_count;
  return 0;
}
