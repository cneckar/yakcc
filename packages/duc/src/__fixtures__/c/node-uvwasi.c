/* SPDX-License-Identifier: Apache-2.0
 * Node's WASI implementation, uvwasi (vendor/node/deps/uvwasi), its parts that compute (#1367):
 * path normalization (WASI's sandboxing of a guest's paths), every WASI error's name, libuv's
 * errors as WASI's, and WASI's structures serialized as a guest reads them. */
#include <stdio.h>
#include <string.h>
#include "uvwasi.h"
#include "wasi_serdes.h"
#include "path_resolver.h"
#include "uv_mapping.h"

/* A path normalized: `rc text`. */
long yk_wasi_normalize(const char *path, long n, char *out, long cap) {
  char buf[512];
  uvwasi_errno_t r = uvwasi__normalize_path(path, (uvwasi_size_t)n, buf, (uvwasi_size_t)n);
  return snprintf(out, (size_t)cap, "%u %s", (unsigned)r, r == 0 ? buf : "");
}

/* Every WASI errno's name, and each libuv error from -1 to -140 as a WASI errno. */
long yk_wasi_errors(char *out, long cap) {
  long k = 0;
  for (int e = 0; e <= 80; e++)
    k += snprintf(out + k, (size_t)(cap - k), "%d %s\n", e, uvwasi_embedder_err_code_to_string((uvwasi_errno_t)e));
  for (int e = -1; e >= -140; e--)
    k += snprintf(out + k, (size_t)(cap - k), "%d>%u ", e, (unsigned)uvwasi__translate_uv_error(e));
  k += snprintf(out + k, (size_t)(cap - k), "%d>%u", UV_EOF, (unsigned)uvwasi__translate_uv_error(UV_EOF));
  return k;
}

/* A file stat, a fd stat and an event from these numbers, serialized; and read back. */
long yk_wasi_serdes(const unsigned long long *v, unsigned char *out) {
  uvwasi_filestat_t fs = {v[0], v[1], (uvwasi_filetype_t)v[2], v[3], v[4], v[5], v[6], v[7]};
  uvwasi_fdstat_t fd = {(uvwasi_filetype_t)v[8], (uvwasi_fdflags_t)v[9], v[10], v[11]};
  uvwasi_event_t ev;
  memset(&ev, 0, sizeof ev);
  ev.userdata = v[12];
  ev.error = (uvwasi_errno_t)v[13];
  ev.type = (uvwasi_eventtype_t)(v[14] % 3);
  ev.u.fd_readwrite.nbytes = v[15];
  ev.u.fd_readwrite.flags = (uvwasi_eventrwflags_t)v[16];
  /* (Padding the writers skip: zero, not whatever was there.) */
  memset(out, 0, UVWASI_SERDES_SIZE_filestat_t + UVWASI_SERDES_SIZE_fdstat_t +
                     UVWASI_SERDES_SIZE_event_t + 16);
  uvwasi_serdes_write_filestat_t(out, 0, &fs);
  uvwasi_serdes_write_fdstat_t(out, UVWASI_SERDES_SIZE_filestat_t, &fd);
  uvwasi_serdes_write_event_t(out, UVWASI_SERDES_SIZE_filestat_t + UVWASI_SERDES_SIZE_fdstat_t, &ev);
  long n = UVWASI_SERDES_SIZE_filestat_t + UVWASI_SERDES_SIZE_fdstat_t + UVWASI_SERDES_SIZE_event_t;
  /* Read back: the fd stat's rights, as a check of the reader. */
  uvwasi_fdstat_t back;
  uvwasi_serdes_read_fdstat_t(out, UVWASI_SERDES_SIZE_filestat_t, &back);
  memcpy(out + n, &back.fs_rights_base, 8);
  memcpy(out + n + 8, &back.fs_rights_inheriting, 8);
  return n + 16;
}
