/* SQLite's engine, whole, on an in-memory database (#1368): the amalgamation with a minimal
 * operating-system layer of its own (SQLITE_OS_OTHER). The VFS opens no files (temporary storage
 * is memory, SQLITE_TEMP_STORE=3); its randomness and clock are fixed, so a run is the same
 * natively and shaved. yk_sqlite_run executes SQL on a fresh database and writes its rows, each
 * column `name=value`, and the result code and message to a buffer. Included by path: built with
 * -I<the amalgamation's directory>. */
#include "sqlite3.c"

static int ykOpen(sqlite3_vfs *v, sqlite3_filename n, sqlite3_file *f, int flags, int *out) {
  (void)v, (void)n, (void)f, (void)flags, (void)out;
  return SQLITE_CANTOPEN;
}
static int ykDelete(sqlite3_vfs *v, const char *n, int sync) { (void)v, (void)n, (void)sync; return SQLITE_OK; }
static int ykAccess(sqlite3_vfs *v, const char *n, int flags, int *out) {
  (void)v, (void)n, (void)flags;
  *out = 0;
  return SQLITE_OK;
}
static int ykFullPathname(sqlite3_vfs *v, const char *n, int size, char *out) {
  (void)v;
  sqlite3_snprintf(size, out, "%s", n);
  return SQLITE_OK;
}
static int ykRandomness(sqlite3_vfs *v, int n, char *out) {
  (void)v;
  for (int i = 0; i < n; i++) out[i] = (char)(i * 37 + 11);
  return n;
}
static int ykSleep(sqlite3_vfs *v, int us) { (void)v; return us; }
static int ykCurrentTime(sqlite3_vfs *v, double *t) { (void)v; *t = 2461000.5; return SQLITE_OK; }
static int ykCurrentTimeInt64(sqlite3_vfs *v, sqlite3_int64 *t) {
  (void)v;
  *t = (sqlite3_int64)2461000 * 86400000 + 43200000;
  return SQLITE_OK;
}
static int ykGetLastError(sqlite3_vfs *v, int n, char *out) { (void)v, (void)n, (void)out; return 0; }

static sqlite3_vfs ykVfs = {
  2, 0, 512, 0, "yk", 0,
  ykOpen, ykDelete, ykAccess, ykFullPathname,
  0, 0, 0, 0,
  ykRandomness, ykSleep, ykCurrentTime, ykGetLastError,
  ykCurrentTimeInt64,
};

int sqlite3_os_init(void) { return sqlite3_vfs_register(&ykVfs, 1); }
int sqlite3_os_end(void) { return SQLITE_OK; }

struct ykOut { char *p; int n, cap; };

static void ykPut(struct ykOut *o, const char *s) {
  while (*s && o->n < o->cap - 1) o->p[o->n++] = *s++;
  o->p[o->n] = 0;
}

static int ykRow(void *ctx, int n, char **values, char **names) {
  struct ykOut *o = ctx;
  for (int i = 0; i < n; i++) {
    ykPut(o, names[i]);
    ykPut(o, "=");
    ykPut(o, values[i] ? values[i] : "NULL");
    ykPut(o, i + 1 < n ? "|" : "\n");
  }
  return 0;
}

/* Runs `sql` on a fresh in-memory database: its rows, then `rc=<code> <message>`, into buf (at most
 * cap bytes, with the NUL). Returns the length. */
int yk_sqlite_run(const char *sql, char *buf, int cap) {
  struct ykOut o = { buf, 0, cap };
  sqlite3 *db = 0;
  char *err = 0;
  int rc = sqlite3_open(":memory:", &db);
  if (rc == SQLITE_OK) rc = sqlite3_exec(db, sql, ykRow, &o, &err);
  char tail[256];
  sqlite3_snprintf(sizeof tail, tail, "rc=%d %s", rc, err ? err : "");
  ykPut(&o, tail);
  sqlite3_free(err);
  sqlite3_close(db);
  return o.n;
}
