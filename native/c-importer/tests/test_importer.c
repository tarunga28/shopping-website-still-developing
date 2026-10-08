/*
 * Test runner for c-importer.
 *
 * Plain C, no framework, so `make test` works with nothing but a compiler. The
 * cases here are the contract the TypeScript import route relies on — in
 * particular the quoted-field rules, because a product description containing a
 * comma is the first thing a real supplier file will throw at the parser.
 */

#include "importer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_failures = 0;
static int g_checks = 0;
static const char* g_current = "";

static void fail(const char* message, const char* file, int line) {
  ++g_failures;
  printf("  FAIL %s\n       %s (%s:%d)\n", g_current, message, file, line);
}

static void run(const char* name, void (*body)(void)) {
  g_current = name;
  const int before = g_failures;
  body();
  if (g_failures == before) printf("  ok   %s\n", name);
}

#define CHECK(condition) \
  do { \
    ++g_checks; \
    if (!(condition)) fail("expected: " #condition, __FILE__, __LINE__); \
  } while (0)

#define CHECK_EQ(actual, expected) \
  do { \
    ++g_checks; \
    if ((actual) != (expected)) { \
      char buffer[160]; \
      snprintf(buffer, sizeof(buffer), "expected %ld, got %ld", (long)(expected), (long)(actual)); \
      fail(buffer, __FILE__, __LINE__); \
    } \
  } while (0)

#define CHECK_STR(actual, expected) \
  do { \
    ++g_checks; \
    const char* actualValue = (actual); \
    if (actualValue == NULL || strcmp(actualValue, (expected)) != 0) { \
      char buffer[256]; \
      snprintf(buffer, sizeof(buffer), "expected \"%s\", got \"%s\"", (expected), \
               actualValue == NULL ? "(null)" : actualValue); \
      fail(buffer, __FILE__, __LINE__); \
    } \
  } while (0)

/* ── parsing ───────────────────────────────────────────────────────────── */

static void test_parses_a_simple_csv(void) {
  static const char data[] = "name,sku,price\nCotton Tee,TEE-001,499.00\nLinen Shirt,SHRT-02,1299.50\n";
  imp_parser* parser = imp_parser_create(data, sizeof(data) - 1, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[16];
  CHECK_EQ(imp_read_header(parser, columns, 16), 3);
  CHECK_STR(columns[0], "name");
  CHECK_STR(columns[2], "price");

  imp_row row;
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_EQ(row.field_count, 3);
  CHECK_STR(row.fields[0], "Cotton Tee");
  CHECK_STR(row.fields[1], "TEE-001");
  CHECK_EQ(row.line_number, 2);

  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_STR(row.fields[1], "SHRT-02");
  CHECK_EQ(row.line_number, 3);

  CHECK_EQ(imp_next_row(parser, &row), 0);  /* end of input */
  imp_parser_free(parser);
}

static void test_handles_quoted_fields_with_delimiters(void) {
  /* The comma inside the description must not split the row. */
  static const char data[] =
      "name,description,price\n\"Classic Tee, unisex\",\"Soft, breathable cotton\",499.00\n";
  imp_parser* parser = imp_parser_create(data, sizeof(data) - 1, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[16];
  imp_read_header(parser, columns, 16);

  imp_row row;
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_EQ(row.field_count, 3);
  CHECK_STR(row.fields[0], "Classic Tee, unisex");
  CHECK_STR(row.fields[1], "Soft, breathable cotton");
  CHECK_STR(row.fields[2], "499.00");

  imp_parser_free(parser);
}

static void test_handles_escaped_quotes(void) {
  /* RFC 4180: "" inside a quoted field is a single literal quote. */
  static const char data[] = "name,description\nTee,\"The \"\"best\"\" tee\"\n";
  imp_parser* parser = imp_parser_create(data, sizeof(data) - 1, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[16];
  imp_read_header(parser, columns, 16);

  imp_row row;
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_STR(row.fields[1], "The \"best\" tee");

  imp_parser_free(parser);
}

static void test_handles_newlines_inside_quoted_fields(void) {
  static const char data[] = "name,description\nTee,\"Line one\nLine two\"\nShirt,X\n";
  imp_parser* parser = imp_parser_create(data, sizeof(data) - 1, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[16];
  imp_read_header(parser, columns, 16);

  imp_row row;
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_EQ(row.field_count, 2);
  CHECK_STR(row.fields[1], "Line one\nLine two");
  /* The embedded newline must be counted, so the next row's line number is right. */
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_STR(row.fields[0], "Shirt");
  CHECK_EQ(row.line_number, 4);

  imp_parser_free(parser);
}

static void test_handles_crlf_and_trailing_blank_lines(void) {
  static const char data[] = "name,sku\r\nTee,T-1\r\n\r\nShirt,S-1\r\n";
  imp_parser* parser = imp_parser_create(data, sizeof(data) - 1, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[16];
  CHECK_EQ(imp_read_header(parser, columns, 16), 2);

  imp_row row;
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_STR(row.fields[1], "T-1");  /* no stray \r */
  /* The blank line is skipped rather than returned as an empty row. */
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_STR(row.fields[0], "Shirt");
  CHECK_EQ(imp_next_row(parser, &row), 0);

  imp_parser_free(parser);
}

static void test_strips_a_byte_order_mark(void) {
  /* Excel writes a BOM; without stripping it the first column name is
   * "\xEF\xBB\xBFname" and the column map silently finds nothing. */
  static const char data[] = "\xEF\xBB\xBFname,sku\nTee,T-1\n";
  imp_parser* parser = imp_parser_create(data, sizeof(data) - 1, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[16];
  imp_read_header(parser, columns, 16);
  CHECK_STR(columns[0], "name");

  imp_column_map map;
  imp_map_columns(columns, 2, &map);
  CHECK_EQ(map.name, 0);

  imp_parser_free(parser);
}

static void test_supports_tab_delimiter(void) {
  static const char data[] = "name\tsku\nCotton Tee\tT-1\n";
  imp_parser* parser = imp_parser_create(data, sizeof(data) - 1, '\t');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[16];
  CHECK_EQ(imp_read_header(parser, columns, 16), 2);

  imp_row row;
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_STR(row.fields[0], "Cotton Tee");

  imp_parser_free(parser);
}

static void test_handles_many_columns(void) {
  /* Build a row wider than the initial field capacity, to exercise growth. */
  char data[8192];
  int written = snprintf(data, sizeof(data), "c0,c1,c2");
  for (int index = 3; index < 200; ++index) {
    written += snprintf(data + written, sizeof(data) - (size_t)written, ",c%d", index);
  }
  written += snprintf(data + written, sizeof(data) - (size_t)written, "\nv0,v1,v2");
  for (int index = 3; index < 200; ++index) {
    written += snprintf(data + written, sizeof(data) - (size_t)written, ",v%d", index);
  }
  written += snprintf(data + written, sizeof(data) - (size_t)written, "\n");

  imp_parser* parser = imp_parser_create(data, (size_t)written, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[256];
  CHECK_EQ(imp_read_header(parser, columns, 256), 200);

  imp_row row;
  CHECK_EQ(imp_next_row(parser, &row), 1);
  CHECK_EQ(row.field_count, 200);
  CHECK_STR(row.fields[199], "v199");

  imp_parser_free(parser);
}

static void test_rejects_bare_fields_over_the_field_cap(void) {
  /* An unquoted field longer than IMP_MAX_FIELD_BYTES must be rejected too. */
  const size_t oversized = IMP_MAX_FIELD_BYTES + 1024;
  char* data = (char*)malloc(oversized + 64);
  CHECK(data != NULL);
  if (data == NULL) return;

  int written = snprintf(data, oversized + 64, "name\n");
  memset(data + written, 'x', oversized);
  written += (int)oversized;
  written += snprintf(data + written, 16, "\n");

  imp_parser* parser = imp_parser_create(data, (size_t)written, ',');
  CHECK(parser != NULL);
  if (parser != NULL) {
    const char* columns[16];
    imp_read_header(parser, columns, 16);
    imp_row row;
    CHECK(imp_next_row(parser, &row) < 0);
    imp_parser_free(parser);
  }
  free(data);
}

static void test_rejects_rows_over_the_size_cap(void) {
  /* One field longer than IMP_MAX_QUOTED_FIELD_BYTES must be rejected, not
   * buffered into memory. */
  const size_t oversized = IMP_MAX_QUOTED_FIELD_BYTES + 1024;
  char* data = (char*)malloc(oversized + 64);
  CHECK(data != NULL);
  if (data == NULL) return;

  int written = snprintf(data, oversized + 64, "name\n\"");
  memset(data + written, 'x', oversized);
  written += (int)oversized;
  written += snprintf(data + written, 16, "\"\n");

  imp_parser* parser = imp_parser_create(data, (size_t)written, ',');
  CHECK(parser != NULL);
  if (parser != NULL) {
    const char* columns[16];
    imp_read_header(parser, columns, 16);
    imp_row row;
    CHECK(imp_next_row(parser, &row) < 0);  /* an error, not a truncated row */
    imp_parser_free(parser);
  }
  free(data);
}

static void test_rejects_null_arguments(void) {
  CHECK(imp_parser_create(NULL, 10, ',') == NULL);
  CHECK(imp_next_row(NULL, NULL) == IMP_ERR_NULL_ARG);
  CHECK(imp_read_header(NULL, NULL, 0) == IMP_ERR_NULL_ARG);
  imp_parser_free(NULL);  /* must not crash */
}

static void test_empty_file_has_no_header(void) {
  imp_parser* parser = imp_parser_create("", 0, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;
  const char* columns[16];
  CHECK_EQ(imp_read_header(parser, columns, 16), IMP_ERR_NO_HEADER);
  imp_parser_free(parser);
}

/* ── column mapping ────────────────────────────────────────────────────── */

static void test_maps_common_supplier_spellings(void) {
  const char* columns[] = {"Product Name", "Item Number", "Unit Price", "Sale Price",
                           "Qty",         "Image URL",   "Contact Email"};
  imp_column_map map;
  CHECK_EQ(imp_map_columns(columns, 7, &map), IMP_OK);
  CHECK_EQ(map.name, 0);
  CHECK_EQ(map.sku, 1);
  CHECK_EQ(map.price, 2);
  CHECK_EQ(map.sale_price, 3);
  CHECK_EQ(map.stock, 4);
  CHECK_EQ(map.image_url, 5);
  CHECK_EQ(map.email, 6);
}

static void test_mapping_is_case_insensitive_and_reports_absent_columns(void) {
  const char* columns[] = {"NAME", "sku"};
  imp_column_map map;
  imp_map_columns(columns, 2, &map);
  CHECK_EQ(map.name, 0);
  CHECK_EQ(map.sku, 1);
  CHECK_EQ(map.price, -1);   /* not present, and must not be guessed */
  CHECK_EQ(map.stock, -1);
  CHECK_EQ(map.email, -1);
}

static void test_mapping_does_not_confuse_similar_headers(void) {
  /* "Selling Price" is a sale price; "Unit Price" is the base price. Mapping
   * them the wrong way round would silently discount every product. */
  const char* columns[] = {"Selling Price", "Unit Price"};
  imp_column_map map;
  imp_map_columns(columns, 2, &map);
  CHECK_EQ(map.sale_price, 0);
  CHECK_EQ(map.price, 1);
}

/* ── field validators ──────────────────────────────────────────────────── */

static void test_sku_validation(void) {
  CHECK(imp_is_valid_sku("TEE-001"));
  CHECK(imp_is_valid_sku("ABC"));         /* minimum length */
  CHECK(imp_is_valid_sku("A_B-C123"));
  CHECK(!imp_is_valid_sku("AB"));         /* too short */
  CHECK(!imp_is_valid_sku("tee-001"));    /* lowercase rejected; normalize first */
  CHECK(!imp_is_valid_sku("TEE 001"));    /* space */
  CHECK(!imp_is_valid_sku("TEE/001"));
  CHECK(!imp_is_valid_sku(NULL));

  char buffer[64];
  snprintf(buffer, sizeof(buffer), "  tee-001  ");
  imp_normalize_sku(buffer);
  CHECK_STR(buffer, "TEE-001");
  CHECK(imp_is_valid_sku(buffer));
}

static void test_amount_parsing_to_minor_units(void) {
  int64_t minor = 0;
  CHECK_EQ(imp_parse_amount_minor("499.00", &minor), IMP_OK);
  CHECK_EQ(minor, 49900);

  CHECK_EQ(imp_parse_amount_minor("1299.50", &minor), IMP_OK);
  CHECK_EQ(minor, 129950);

  /* "19.5" means 19.50, not 19.05. */
  CHECK_EQ(imp_parse_amount_minor("19.5", &minor), IMP_OK);
  CHECK_EQ(minor, 1950);

  CHECK_EQ(imp_parse_amount_minor("0", &minor), IMP_OK);
  CHECK_EQ(minor, 0);

  /* Thousands separators are cosmetic and must not change the value. */
  CHECK_EQ(imp_parse_amount_minor("1,299.99", &minor), IMP_OK);
  CHECK_EQ(minor, 129999);

  /* The INR sign is common in this codebase's supplier files. */
  CHECK_EQ(imp_parse_amount_minor("\xE2\x82\xB9" "499.00", &minor), IMP_OK);
  CHECK_EQ(minor, 49900);

  /* Rejected rather than rounded: three decimal places cannot be represented
   * in minor units without losing money. */
  CHECK(imp_parse_amount_minor("1.234", &minor) < 0);
  CHECK(imp_parse_amount_minor("-5.00", &minor) < 0);
  CHECK(imp_parse_amount_minor("abc", &minor) < 0);
  CHECK(imp_parse_amount_minor("1.2.3", &minor) < 0);
  CHECK(imp_parse_amount_minor("", &minor) < 0);
  CHECK(imp_parse_amount_minor(NULL, &minor) < 0);
}

static void test_integer_validation(void) {
  CHECK(imp_is_valid_non_negative_int("0"));
  CHECK(imp_is_valid_non_negative_int("42"));
  CHECK(imp_is_valid_non_negative_int("1,000"));
  CHECK(!imp_is_valid_non_negative_int("-1"));   /* negative stock is not a count */
  CHECK(!imp_is_valid_non_negative_int("12.5"));
  CHECK(!imp_is_valid_non_negative_int(""));
  CHECK(!imp_is_valid_non_negative_int(NULL));
}

static void test_url_validation(void) {
  CHECK(imp_is_valid_http_url("https://cdn.inkline.test/products/tee.jpg"));
  CHECK(imp_is_valid_http_url("http://example.com/a.png"));
  CHECK(!imp_is_valid_http_url("/products/tee.jpg"));       /* relative */
  CHECK(!imp_is_valid_http_url("//cdn.example.com/a.jpg")); /* scheme-less */
  CHECK(!imp_is_valid_http_url("ftp://example.com/a.jpg"));
  CHECK(!imp_is_valid_http_url("https://localhost"));       /* no dot in host */
  CHECK(!imp_is_valid_http_url("https://exa mple.com/a.jpg"));
  CHECK(!imp_is_valid_http_url(NULL));
}

static void test_email_validation(void) {
  CHECK(imp_is_valid_email("supplier@example.com"));
  CHECK(!imp_is_valid_email("supplier@example"));   /* no dot in domain */
  CHECK(!imp_is_valid_email("@example.com"));
  CHECK(!imp_is_valid_email("supplier@"));
  CHECK(!imp_is_valid_email("a@@b.com"));
  CHECK(!imp_is_valid_email(" supplier@example.com"));
  CHECK(!imp_is_valid_email(NULL));
}

/* ── row validation ────────────────────────────────────────────────────── */

static void test_validate_reports_every_problem_in_a_row(void) {
  const char* fields[] = {"", "bad sku!", "abc", "-5"};
  imp_row row;
  row.fields = fields;
  row.field_count = 4;
  row.line_number = 2;

  imp_column_map map;
  map.name = 0;
  map.sku = 1;
  map.price = 2;
  map.stock = 3;
  map.sale_price = -1;
  map.image_url = -1;
  map.email = -1;

  imp_issue issues[8];
  const int found = imp_validate_row(&row, &map, issues, 8);
  /* empty name, bad sku, bad price, bad stock — all four, not just the first */
  CHECK_EQ(found, 4);
  CHECK_EQ(issues[0].kind, IMP_ISSUE_EMPTY_NAME);
  CHECK_EQ(issues[1].kind, IMP_ISSUE_BAD_SKU);
  CHECK_EQ(issues[2].kind, IMP_ISSUE_BAD_NUMBER);
  CHECK_EQ(issues[3].kind, IMP_ISSUE_BAD_NUMBER);
  CHECK(issues[0].message != NULL);
}

static void test_validate_accepts_a_clean_row(void) {
  const char* fields[] = {"Cotton Tee", "TEE-001", "499.00", "25", "https://cdn.inkline.test/a.jpg",
                          "supplier@example.com"};
  imp_row row;
  row.fields = fields;
  row.field_count = 6;
  row.line_number = 2;

  imp_column_map map;
  map.name = 0;
  map.sku = 1;
  map.price = 2;
  map.stock = 3;
  map.image_url = 4;
  map.email = 5;
  map.sale_price = -1;

  imp_issue issues[8];
  CHECK_EQ(imp_validate_row(&row, &map, issues, 8), 0);
}

static void test_validate_reports_a_missing_required_column(void) {
  const char* fields[] = {"TEE-001"};
  imp_row row;
  row.fields = fields;
  row.field_count = 1;
  row.line_number = 2;

  imp_column_map map;
  memset(&map, 0xFF, sizeof(map));  /* every column absent */

  imp_issue issues[4];
  const int found = imp_validate_row(&row, &map, issues, 4);
  CHECK_EQ(found, 1);
  CHECK_EQ(issues[0].kind, IMP_ISSUE_MISSING_REQUIRED);
}

static void test_validate_tolerates_a_short_row(void) {
  /* A ragged row must not read past the end of the field array. */
  const char* fields[] = {"Cotton Tee"};
  imp_row row;
  row.fields = fields;
  row.field_count = 1;
  row.line_number = 2;

  imp_column_map map;
  map.name = 0;
  map.sku = 1;   /* beyond field_count */
  map.price = 5; /* well beyond */
  map.sale_price = -1;
  map.stock = -1;
  map.image_url = -1;
  map.email = -1;

  imp_issue issues[4];
  CHECK(imp_validate_row(&row, &map, issues, 4) >= 0);
}

static void test_validate_counts_beyond_the_buffer(void) {
  const char* fields[] = {"", "bad sku!", "abc", "-5"};
  imp_row row;
  row.fields = fields;
  row.field_count = 4;
  row.line_number = 2;

  imp_column_map map;
  map.name = 0;
  map.sku = 1;
  map.price = 2;
  map.stock = 3;
  map.sale_price = -1;
  map.image_url = -1;
  map.email = -1;

  imp_issue issues[2];
  /* Four problems, room for two: the count must still be four so the caller can
   * report "and 2 more". */
  CHECK_EQ(imp_validate_row(&row, &map, issues, 2), 4);
}

/* ── in-file duplicate detection ───────────────────────────────────────── */

static void test_note_sku_detects_duplicates_within_a_file(void) {
  imp_parser* parser = imp_parser_create("a\n1\n", 4, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  CHECK_EQ(imp_note_sku(parser, "TEE-001", 1000), 0);  /* first sighting */
  CHECK_EQ(imp_note_sku(parser, "TEE-002", 1000), 0);
  CHECK_EQ(imp_note_sku(parser, "TEE-001", 1000), 1);  /* duplicate */
  CHECK_EQ(imp_note_sku(parser, "TEE-003", 1000), 0);

  CHECK(imp_note_sku(parser, NULL, 1000) < 0);
  CHECK(imp_note_sku(NULL, "TEE-004", 1000) < 0);

  imp_parser_free(parser);
}

static void test_note_sku_stops_growing_past_the_bound(void) {
  imp_parser* parser = imp_parser_create("a\n1\n", 4, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  char sku[32];
  for (int index = 0; index < 100; ++index) {
    snprintf(sku, sizeof(sku), "SKU-%04d", index);
    imp_note_sku(parser, sku, 10);
  }
  /* Past the bound the importer stops tracking rather than growing without
   * limit; a later duplicate simply goes unreported. */
  CHECK_EQ(imp_note_sku(parser, "SKU-0050", 10), 0);

  imp_parser_free(parser);
}

static void test_note_sku_survives_many_entries(void) {
  /* Enough entries to force the open-addressed table to probe. */
  imp_parser* parser = imp_parser_create("a\n1\n", 4, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  char sku[32];
  for (int index = 0; index < 5000; ++index) {
    snprintf(sku, sizeof(sku), "SKU-%06d", index);
    CHECK_EQ(imp_note_sku(parser, sku, 100000), 0);
  }
  snprintf(sku, sizeof(sku), "SKU-%06d", 2500);
  CHECK_EQ(imp_note_sku(parser, sku, 100000), 1);

  imp_parser_free(parser);
}

/* ── end to end ────────────────────────────────────────────────────────── */

static void test_end_to_end_import_of_a_small_feed(void) {
  static const char data[] =
      "Product Name,Item Number,Unit Price,Qty,Image URL\n"
      "\"Cotton Tee, unisex\",TEE-001,499.00,25,https://cdn.inkline.test/tee.jpg\n"
      "Linen Shirt,TEE-001,1299.50,10,https://cdn.inkline.test/shirt.jpg\n"  /* duplicate SKU */
      ",BAD SKU,abc,-3,not-a-url\n";                                         /* four problems */
  imp_parser* parser = imp_parser_create(data, sizeof(data) - 1, ',');
  CHECK(parser != NULL);
  if (parser == NULL) return;

  const char* columns[16];
  const int column_count = imp_read_header(parser, columns, 16);
  CHECK_EQ(column_count, 5);

  imp_column_map map;
  imp_map_columns(columns, (size_t)column_count, &map);
  CHECK_EQ(map.name, 0);
  CHECK_EQ(map.sku, 1);
  CHECK_EQ(map.price, 2);
  CHECK_EQ(map.stock, 3);
  CHECK_EQ(map.image_url, 4);

  int rows = 0;
  int usable_rows = 0;
  int duplicate_skus = 0;
  int shape_problems = 0;
  imp_row row;
  imp_issue issues[8];

  while (imp_next_row(parser, &row) == 1) {
    ++rows;
    /* imp_validate_row checks row shape; duplicate SKUs are only knowable from
     * imp_note_sku. A row is usable only when both checks pass. */
    const int row_problems = imp_validate_row(&row, &map, issues, 8);
    shape_problems += row_problems;

    int is_duplicate = 0;
    if (map.sku >= 0 && (size_t)map.sku < row.field_count && row.fields[map.sku][0] != '\0') {
      is_duplicate = imp_note_sku(parser, row.fields[map.sku], 1000) == 1;
      if (is_duplicate) ++duplicate_skus;
    }
    if (row_problems == 0 && !is_duplicate) ++usable_rows;
  }

  CHECK_EQ(rows, 3);
  CHECK_EQ(usable_rows, 1);       /* row 1 only: row 2 repeats an SKU, row 3 is malformed */
  CHECK_EQ(duplicate_skus, 1);    /* the second row repeats TEE-001 */
  /* Five on the last row: empty name, bad SKU, bad price, bad stock, bad URL. */
  CHECK_EQ(shape_problems, 5);

  imp_parser_free(parser);
}

int main(void) {
  printf("c-importer test suite\n");

  run("parsing: reads a simple CSV", test_parses_a_simple_csv);
  run("parsing: keeps delimiters inside quoted fields", test_handles_quoted_fields_with_delimiters);
  run("parsing: unescapes doubled quotes", test_handles_escaped_quotes);
  run("parsing: allows newlines inside quoted fields", test_handles_newlines_inside_quoted_fields);
  run("parsing: handles CRLF and trailing blank lines", test_handles_crlf_and_trailing_blank_lines);
  run("parsing: strips a UTF-8 byte order mark", test_strips_a_byte_order_mark);
  run("parsing: supports a tab delimiter", test_supports_tab_delimiter);
  run("parsing: grows past the initial column capacity", test_handles_many_columns);
  run("parsing: rejects rows over the size cap", test_rejects_rows_over_the_size_cap);
  run("parsing: rejects bare fields over the field cap", test_rejects_bare_fields_over_the_field_cap);
  run("parsing: rejects NULL arguments", test_rejects_null_arguments);
  run("parsing: reports a missing header", test_empty_file_has_no_header);

  run("columns: maps common supplier spellings", test_maps_common_supplier_spellings);
  run("columns: matching is case-insensitive", test_mapping_is_case_insensitive_and_reports_absent_columns);
  run("columns: does not confuse base and sale price", test_mapping_does_not_confuse_similar_headers);

  run("fields: SKU validation", test_sku_validation);
  run("fields: amounts parse to exact minor units", test_amount_parsing_to_minor_units);
  run("fields: integer validation", test_integer_validation);
  run("fields: URL validation", test_url_validation);
  run("fields: email validation", test_email_validation);

  run("rows: reports every problem in a row", test_validate_reports_every_problem_in_a_row);
  run("rows: accepts a clean row", test_validate_accepts_a_clean_row);
  run("rows: reports a missing required column", test_validate_reports_a_missing_required_column);
  run("rows: tolerates a row shorter than the header", test_validate_tolerates_a_short_row);
  run("rows: counts problems beyond the buffer", test_validate_counts_beyond_the_buffer);

  run("dedupe: finds duplicate SKUs within a file", test_note_sku_detects_duplicates_within_a_file);
  run("dedupe: stops growing past the bound", test_note_sku_stops_growing_past_the_bound);
  run("dedupe: survives thousands of entries", test_note_sku_survives_many_entries);

  run("end to end: imports a small messy feed", test_end_to_end_import_of_a_small_feed);

  printf("\n%d checks, %d failure(s)\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
