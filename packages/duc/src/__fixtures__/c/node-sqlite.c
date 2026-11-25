/* SPDX-License-Identifier: Apache-2.0
 * Node's SQLite (vendor/node/deps/sqlite, node:sqlite's engine) as Node's DatabaseSync opens it
 * (#1368): an in-memory database, double-quoted string literals off, foreign keys on. Each
 * statement of a script (NUL-separated) runs in turn; its rows (each value by its type: I integer, R a REAL's bits,
 * T text's bytes, B a blob's, N null) or its error (the extended code and message) are written to
 * a buffer, a line each. Included by path: built with -I<the amalgamation's directory>. */
#include "sqlite3.c"
#include <string.h>

typedef struct {
  char *out;
  long cap, n;
} ykBuf;

static void ykPut(ykBuf *b, const char *s, long len) {
  for (long i = 0; i < len && b->n < b->cap - 1; i++) b->out[b->n++] = s[i];
}
static void ykHex(ykBuf *b, const unsigned char *p, long len) {
  static const char d[] = "0123456789abcdef";
  for (long i = 0; i < len && b->n < b->cap - 2; i++) {
    b->out[b->n++] = d[p[i] >> 4];
    b->out[b->n++] = d[p[i] & 15];
  }
}

long yk_node_sqlite(const char *script, long n, char *out, long cap) {
  ykBuf b = {out, cap, 0};
  sqlite3 *db = 0;
  int r = sqlite3_open_v2(":memory:", &db,
                          SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, 0);
  if (r != SQLITE_OK) return -1;
  sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DML, 0, (int *)0);
  sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DDL, 0, (int *)0);
  int fk = 0;
  sqlite3_db_config(db, SQLITE_DBCONFIG_ENABLE_FKEY, 1, &fk);
  sqlite3_busy_timeout(db, 0);
  const char *at = script, *end = script + n;
  char tmp[64];
  /* Each statement (NUL-separated), prepared once as Node's prepare(sql) does. */
  while (at < end) {
    long len = (long)strnlen(at, (size_t)(end - at));
    sqlite3_stmt *st = 0;
    r = sqlite3_prepare_v2(db, at, (int)len, &st, 0);
    long start = b.n;
    if (r == SQLITE_OK && st == 0) r = SQLITE_DONE; /* no statement: nothing to run */
    else if (r == SQLITE_OK) {
      ykPut(&b, "S", 1);
      while ((r = sqlite3_step(st)) == SQLITE_ROW) {
        ykPut(&b, " [", 2);
        for (int c = 0; c < sqlite3_column_count(st); c++) {
          if (c > 0) ykPut(&b, ",", 1);
          switch (sqlite3_column_type(st, c)) {
            case SQLITE_INTEGER:
              sqlite3_snprintf(sizeof tmp, tmp, "I%lld", sqlite3_column_int64(st, c));
              ykPut(&b, tmp, (long)strlen(tmp));
              break;
            case SQLITE_FLOAT: {
              double v = sqlite3_column_double(st, c);
              unsigned char bits[8];
              unsigned long long u;
              memcpy(&u, &v, 8);
              for (int i = 0; i < 8; i++) bits[i] = (unsigned char)(u >> (56 - 8 * i));
              ykPut(&b, "R", 1);
              ykHex(&b, bits, 8);
              break;
            }
            case SQLITE_TEXT:
              ykPut(&b, "T", 1);
              ykHex(&b, sqlite3_column_text(st, c), sqlite3_column_bytes(st, c));
              break;
            case SQLITE_BLOB:
              ykPut(&b, "B", 1);
              ykHex(&b, (const unsigned char *)sqlite3_column_blob(st, c), sqlite3_column_bytes(st, c));
              break;
            default:
              ykPut(&b, "N", 1);
          }
        }
        ykPut(&b, "]", 1);
      }
    }
    if (r != SQLITE_DONE) {
      b.n = start; /* Node's DatabaseSync throws: the rows are not returned */
      const char *msg = sqlite3_errmsg(db);
      sqlite3_snprintf(sizeof tmp, tmp, "E %d ", sqlite3_extended_errcode(db));
      ykPut(&b, tmp, (long)strlen(tmp));
      ykPut(&b, msg, (long)strlen(msg));
    }
    ykPut(&b, "\n", 1);
    sqlite3_finalize(st);
    at += len + 1;
  }
  sqlite3_close(db);
  return b.n;
}
