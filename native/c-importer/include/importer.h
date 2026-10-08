/*
 * c-importer — bulk catalog ingestion.
 *
 * Purpose: turn a supplier CSV (or any RFC-4180-ish delimited dump) into
 * validated row records at a rate that makes a nightly 500k-row feed a
 * non-event. Parsing and per-field validation are pure CPU work over a byte
 * stream, which is exactly the case for C: no allocation per token, one pass,
 * bounded memory regardless of file size.
 *
 * Deliberate limits, so this stays a utility and not a second application:
 *   - No database access. It produces records; the caller persists them.
 *   - No business rules about pricing or stock policy. It reports malformed
 *     data; what to do about it is the caller's decision.
 *   - Row size is capped so one pathological line cannot exhaust memory.
 *
 * Build: see Makefile. Consumed from Node via the C ABI in importer_abi.h.
 */

#ifndef INKLINE_IMPORTER_H
#define INKLINE_IMPORTER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define IMP_OK 0
#define IMP_ERR_NULL_ARG -1
#define IMP_ERR_ALLOC -2
#define IMP_ERR_TOO_LARGE -3
#define IMP_ERR_NO_HEADER -4

/** Longest single row accepted, in bytes. Larger rows are rejected, not buffered. */
#define IMP_MAX_ROW_BYTES (256 * 1024)

/** Longest single field accepted, in bytes. */
#define IMP_MAX_FIELD_BYTES (16 * 1024)

/** Longest quoted field, in bytes. Quoted fields may be longer than bare ones. */
#define IMP_MAX_QUOTED_FIELD_BYTES (64 * 1024)

/**
 * One parsed row.
 *
 * `fields` points into the parser's own buffer, so the values are valid only
 * until the next imp_next_row() call or until the parser is freed. Copy
 * anything you need to keep — that is the price of not allocating per row.
 */
typedef struct imp_row {
  const char* const* fields;
  size_t field_count;
  /** 1-based line number in the source, for error messages users can act on. */
  size_t line_number;
} imp_row;

typedef struct imp_parser imp_parser;

/** Per-row problem the caller can surface to whoever supplied the file. */
typedef enum imp_issue_kind {
  IMP_ISSUE_NONE = 0,
  IMP_ISSUE_MISSING_REQUIRED = 1,
  IMP_ISSUE_EMPTY_NAME = 2,
  IMP_ISSUE_BAD_SKU = 3,
  IMP_ISSUE_DUPLICATE_SKU = 4,
  IMP_ISSUE_NEGATIVE_PRICE = 5,
  IMP_ISSUE_BAD_NUMBER = 6,
  IMP_ISSUE_FIELD_COUNT_MISMATCH = 7,
  IMP_ISSUE_BAD_URL = 8,
  IMP_ISSUE_BAD_EMAIL = 9,
  IMP_ISSUE_ROW_TOO_LARGE = 10
} imp_issue_kind;

typedef struct imp_issue {
  imp_issue_kind kind;
  /** Column index the problem was found in, or SIZE_MAX when row-wide. */
  size_t field_index;
  const char* message;
} imp_issue;

/** Columns the importer knows how to check. Everything else passes through. */
typedef struct imp_column_map {
  int name;
  int sku;
  int price;
  int sale_price;
  int stock;
  int image_url;
  int email;
} imp_column_map;

/**
 * Create a parser over an in-memory buffer.
 *
 * The buffer is NOT copied and must outlive the parser. `delimiter` is a single
 * byte; pass ',' for CSV and '\t' for TSV.
 */
imp_parser* imp_parser_create(const char* data, size_t length, char delimiter);

void imp_parser_free(imp_parser* parser);

/**
 * Read the header row and return the column names.
 *
 * Returns the column count, or a negative error code. Required before
 * imp_next_row(), because a file without a header has no stable column
 * meanings and silently importing by position is how catalogs get corrupted.
 */
int imp_read_header(imp_parser* parser, const char** out_columns, size_t capacity);

/**
 * Locate columns by header name, case-insensitively and tolerant of the usual
 * supplier spellings ("SKU", "sku", "Item Number", "Unit Price", …).
 *
 * Returns 0 on success. A column that is not found is set to -1.
 */
int imp_map_columns(const char* const* columns, size_t column_count, imp_column_map* out_map);

/** Advance to the next data row. Returns 1 on success, 0 at end of input. */
int imp_next_row(imp_parser* parser, imp_row* out_row);

/**
 * Validate a row against the column map.
 *
 * Writes up to `capacity` issues into `out_issues` and returns how many were
 * found (which may exceed `capacity`, so the caller can report "and N more").
 * Returns a negative code only on bad arguments.
 *
 * This checks *shape*, not policy: an SKU that is syntactically fine but
 * already in the database is the caller's problem, since only the caller can
 * see the database.
 */
int imp_validate_row(const imp_row* row, const imp_column_map* map,
                     imp_issue* out_issues, size_t capacity);

/**
 * Record an SKU the importer has already seen in this file, so duplicates
 * *within the feed* are caught before they reach the database.
 *
 * Returns 1 when the SKU was already present, 0 when newly recorded, negative
 * on error. Bounded memory: the set stops growing past `max_entries` and
 * reports duplicates only up to that point, rather than risking OOM on a
 * malicious or corrupt multi-gigabyte file.
 */
int imp_note_sku(imp_parser* parser, const char* sku, size_t max_entries);

/* ── Stateless field validators, exported for reuse and testing ───────── */

/** True when `value` is a well-formed SKU: 3-64 chars, [A-Z0-9] plus '-'/'_'. */
int imp_is_valid_sku(const char* value);

/** True when the value parses as a non-negative decimal amount. */
int imp_is_valid_amount(const char* value);

/** True when the value parses as a non-negative integer. */
int imp_is_valid_non_negative_int(const char* value);

/** True when the value is an absolute http(s) URL with a host. */
int imp_is_valid_http_url(const char* value);

/** True when the value has one '@' with text on both sides. */
int imp_is_valid_email(const char* value);

/**
 * Parse a decimal amount into minor units (paise/cents).
 *
 * Integer arithmetic throughout: no floating point, so 19.99 never becomes
 * 1998.9999. Returns 0 on success and a negative code when the text is not a
 * well-formed non-negative amount.
 */
int imp_parse_amount_minor(const char* value, int64_t* out_minor_units);

/** Uppercase and trim an SKU in place. Returns the new length. */
size_t imp_normalize_sku(char* value);

#ifdef __cplusplus
}
#endif

#endif /* INKLINE_IMPORTER_H */
