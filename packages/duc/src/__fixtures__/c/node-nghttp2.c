/* SPDX-License-Identifier: Apache-2.0
 * Node's HTTP/2 library, nghttp2 (vendor/node/deps/nghttp2), as C functions for the C front end's
 * test (#1367): HPACK (header compression, its dynamic table carried from list to list) and a whole
 * exchange between a client and a server session in memory, every frame and callback logged. */
#include <stdio.h>
#include <string.h>
#include <nghttp2/nghttp2.h>

typedef struct {
  char *out;
  long cap, n;
} yk_log;

static void yk_put(yk_log *l, const void *p, long len) {
  for (long i = 0; i < len && l->n < l->cap - 1; i++) l->out[l->n++] = ((const char *)p)[i];
}
static void yk_puts(yk_log *l, const char *s) { yk_put(l, s, (long)strlen(s)); }
static void yk_hex(yk_log *l, const unsigned char *p, long len) {
  static const char d[] = "0123456789abcdef";
  for (long i = 0; i < len && l->n < l->cap - 2; i++) {
    l->out[l->n++] = d[p[i] >> 4];
    l->out[l->n++] = d[p[i] & 15];
  }
}
static void yk_num(yk_log *l, long v) {
  char b[32];
  snprintf(b, sizeof b, "%ld", v);
  yk_puts(l, b);
}

/* Header lists (`name\tvalue\n` lines, lists separated by an empty line) through one deflater and
 * one inflater with a dynamic table of `table` bytes: each list's block, then what inflating it
 * gives, then what inflating it with byte `flip` of it changed gives. The log's length. */
long yk_hpack(const char *lists, long n, long table, long flip, char *out, long cap) {
  yk_log l = {out, cap, 0};
  nghttp2_hd_deflater *def;
  nghttp2_hd_inflater *inf, *inf2;
  if (nghttp2_hd_deflate_new(&def, (size_t)table) != 0) return -1;
  nghttp2_hd_inflate_new(&inf);
  nghttp2_hd_inflate_new(&inf2);
  nghttp2_nv nva[64];
  static unsigned char block[1 << 16];
  const char *at = lists, *end = lists + n;
  while (at < end) {
    size_t k = 0;
    while (at < end && *at != '\n' && k < 64) {
      const char *tab = memchr(at, '\t', (size_t)(end - at));
      const char *nl = memchr(at, '\n', (size_t)(end - at));
      if (tab == NULL || nl == NULL || tab > nl) return -2;
      nva[k].name = (uint8_t *)at;
      nva[k].namelen = (size_t)(tab - at);
      nva[k].value = (uint8_t *)tab + 1;
      nva[k].valuelen = (size_t)(nl - tab - 1);
      nva[k].flags = (nva[k].valuelen > 0 && tab[1] == '!') ? NGHTTP2_NV_FLAG_NO_INDEX : NGHTTP2_NV_FLAG_NONE;
      k++;
      at = nl + 1;
    }
    if (at < end && *at == '\n') at++;
    nghttp2_ssize m = nghttp2_hd_deflate_hd2(def, block, sizeof block, nva, k);
    yk_puts(&l, "D ");
    yk_num(&l, (long)m);
    yk_puts(&l, " ");
    if (m > 0) yk_hex(&l, block, m);
    yk_puts(&l, "\n");
    if (m < 0) continue;
    for (int pass = 0; pass < 2; pass++) {
      nghttp2_hd_inflater *in = pass == 0 ? inf : inf2;
      if (pass == 1 && m > 0) block[flip % m] ^= 0x5a;
      yk_puts(&l, pass == 0 ? "I" : "C");
      const uint8_t *p = block;
      size_t left = (size_t)m;
      for (;;) {
        nghttp2_nv nv;
        int flags = 0;
        nghttp2_ssize r = nghttp2_hd_inflate_hd3(in, &nv, &flags, p, left, 1);
        if (r < 0) {
          yk_puts(&l, " error ");
          yk_num(&l, (long)r);
          break;
        }
        p += r;
        left -= (size_t)r;
        if (flags & NGHTTP2_HD_INFLATE_EMIT) {
          yk_puts(&l, " ");
          yk_put(&l, nv.name, (long)nv.namelen);
          yk_puts(&l, "=");
          yk_put(&l, nv.value, (long)nv.valuelen);
        }
        if (flags & NGHTTP2_HD_INFLATE_FINAL) {
          nghttp2_hd_inflate_end_headers(in);
          break;
        }
        if (r == 0 && left == 0) break;
      }
      yk_puts(&l, "\n");
    }
  }
  yk_puts(&l, "table ");
  yk_num(&l, (long)nghttp2_hd_deflate_get_dynamic_table_size(def));
  yk_puts(&l, " ");
  yk_num(&l, (long)nghttp2_hd_inflate_get_dynamic_table_size(inf));
  nghttp2_hd_deflate_del(def);
  nghttp2_hd_inflate_del(inf);
  nghttp2_hd_inflate_del(inf2);
  return l.n;
}

/* --- A client and a server session talking in memory. */
typedef struct {
  yk_log *l;
  const char *side;
  const uint8_t *body;
  size_t body_len, body_at;
} yk_peer;

static int yk_on_frame(nghttp2_session *s, const nghttp2_frame *f, void *u) {
  yk_peer *p = (yk_peer *)u;
  (void)s;
  char b[96];
  snprintf(b, sizeof b, "%s frame type=%d stream=%d flags=%d len=%zu\n", p->side, f->hd.type,
           f->hd.stream_id, f->hd.flags, f->hd.length);
  yk_puts(p->l, b);
  return 0;
}
static int yk_on_header(nghttp2_session *s, const nghttp2_frame *f, const uint8_t *name, size_t nl,
                        const uint8_t *value, size_t vl, uint8_t flags, void *u) {
  yk_peer *p = (yk_peer *)u;
  (void)s, (void)flags;
  yk_puts(p->l, p->side);
  yk_puts(p->l, " header ");
  yk_num(p->l, f->hd.stream_id);
  yk_puts(p->l, " ");
  yk_put(p->l, name, (long)nl);
  yk_puts(p->l, "=");
  yk_put(p->l, value, (long)vl);
  yk_puts(p->l, "\n");
  return 0;
}
static int yk_on_data(nghttp2_session *s, uint8_t flags, int32_t id, const uint8_t *d, size_t len,
                      void *u) {
  yk_peer *p = (yk_peer *)u;
  (void)s, (void)flags;
  yk_puts(p->l, p->side);
  yk_puts(p->l, " data ");
  yk_num(p->l, id);
  yk_puts(p->l, " ");
  yk_hex(p->l, d, (long)len);
  yk_puts(p->l, "\n");
  return 0;
}
static int yk_on_close(nghttp2_session *s, int32_t id, uint32_t code, void *u) {
  yk_peer *p = (yk_peer *)u;
  (void)s;
  yk_puts(p->l, p->side);
  yk_puts(p->l, " close ");
  yk_num(p->l, id);
  yk_puts(p->l, " ");
  yk_num(p->l, (long)code);
  yk_puts(p->l, "\n");
  return 0;
}
static nghttp2_ssize yk_read_body(nghttp2_session *s, int32_t id, uint8_t *buf, size_t len,
                                  uint32_t *flags, nghttp2_data_source *src, void *u) {
  yk_peer *p = (yk_peer *)u;
  (void)s, (void)id, (void)src;
  size_t k = p->body_len - p->body_at;
  if (k > len) k = len;
  memcpy(buf, p->body + p->body_at, k);
  p->body_at += k;
  if (p->body_at == p->body_len) *flags |= NGHTTP2_DATA_FLAG_EOF;
  return (nghttp2_ssize)k;
}
static int yk_on_request_end(nghttp2_session *s, const nghttp2_frame *f, void *u);

static nghttp2_session *yk_new(int server, yk_peer *p, long window) {
  nghttp2_session_callbacks *cb;
  nghttp2_session_callbacks_new(&cb);
  nghttp2_session_callbacks_set_on_frame_recv_callback(cb, server ? yk_on_request_end : yk_on_frame);
  nghttp2_session_callbacks_set_on_header_callback(cb, yk_on_header);
  nghttp2_session_callbacks_set_on_data_chunk_recv_callback(cb, yk_on_data);
  nghttp2_session_callbacks_set_on_stream_close_callback(cb, yk_on_close);
  nghttp2_session *s;
  if (server) nghttp2_session_server_new(&s, cb, p);
  else nghttp2_session_client_new(&s, cb, p);
  nghttp2_session_callbacks_del(cb);
  nghttp2_settings_entry iv[2] = {{NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, 100},
                                  {NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE, (uint32_t)window}};
  nghttp2_submit_settings(s, NGHTTP2_FLAG_NONE, iv, 2);
  return s;
}

/* The server answers each request when it ends: 200 with the request body back (or 404 for a path
   of /missing). */
static int yk_on_request_end(nghttp2_session *s, const nghttp2_frame *f, void *u) {
  yk_peer *p = (yk_peer *)u;
  yk_on_frame(s, f, u);
  if ((f->hd.type == NGHTTP2_HEADERS || f->hd.type == NGHTTP2_DATA) &&
      (f->hd.flags & NGHTTP2_FLAG_END_STREAM)) {
    nghttp2_nv nv[2] = {{(uint8_t *)":status", (uint8_t *)"200", 7, 3, 0},
                        {(uint8_t *)"server", (uint8_t *)"yk", 6, 2, 0}};
    nghttp2_data_provider2 dp = {{0}, yk_read_body};
    nghttp2_submit_response2(s, f->hd.stream_id, nv, 2, p->body_len > 0 ? &dp : NULL);
  }
  return 0;
}

/* Requests (each `method path` then header lines `name\tvalue`, requests separated by an empty
   line) with a body each of `body`, exchanged with `chunk`-byte reads; the server echoes `reply`.
   Every frame each side sends (hex) and every callback is logged. */
long yk_h2(const char *reqs, long n, const unsigned char *body, long blen, const unsigned char *reply,
           long rlen, long window, long chunk, char *out, long cap) {
  yk_log l = {out, cap, 0};
  yk_peer cp = {&l, "client", body, (size_t)blen, 0}, sp = {&l, "server", reply, (size_t)rlen, 0};
  nghttp2_session *c = yk_new(0, &cp, window), *sv = yk_new(1, &sp, window);
  nghttp2_nv nva[32];
  const char *at = reqs, *end = reqs + n;
  while (at < end) {
    size_t k = 0;
    while (at < end && *at != '\n' && k < 32) {
      const char *tab = memchr(at, '\t', (size_t)(end - at));
      const char *nl = memchr(at, '\n', (size_t)(end - at));
      if (tab == NULL || nl == NULL || tab > nl) return -2;
      nva[k].name = (uint8_t *)at;
      nva[k].namelen = (size_t)(tab - at);
      nva[k].value = (uint8_t *)tab + 1;
      nva[k].valuelen = (size_t)(nl - tab - 1);
      nva[k].flags = NGHTTP2_NV_FLAG_NONE;
      k++;
      at = nl + 1;
    }
    if (at < end && *at == '\n') at++;
    nghttp2_data_provider2 dp = {{0}, yk_read_body};
    cp.body_at = 0;
    int32_t id = nghttp2_submit_request2(c, NULL, nva, k, blen > 0 ? &dp : NULL, NULL);
    yk_puts(&l, "submit ");
    yk_num(&l, id);
    yk_puts(&l, "\n");
    /* Each request's exchange to quiet. */
    for (int round = 0; round < 64; round++) {
      int moved = 0;
      for (int side = 0; side < 2; side++) {
        nghttp2_session *from = side ? sv : c, *to = side ? c : sv;
        const uint8_t *data;
        nghttp2_ssize m;
        while ((m = nghttp2_session_mem_send2(from, &data)) > 0) {
          moved = 1;
          yk_puts(&l, side ? "server sends " : "client sends ");
          yk_hex(&l, data, m);
          yk_puts(&l, "\n");
          for (nghttp2_ssize o = 0; o < m;) {
            nghttp2_ssize k2 = m - o < chunk ? m - o : chunk;
            nghttp2_ssize r = nghttp2_session_mem_recv2(to, data + o, (size_t)k2);
            if (r < 0) {
              yk_puts(&l, "recv error ");
              yk_puts(&l, nghttp2_strerror((int)r));
              yk_puts(&l, "\n");
              break;
            }
            o += k2;
          }
        }
        if (m < 0) {
          yk_puts(&l, "send error ");
          yk_puts(&l, nghttp2_strerror((int)m));
          yk_puts(&l, "\n");
        }
      }
      if (!moved) break;
    }
    sp.body_at = 0;
  }
  nghttp2_session_terminate_session(c, NGHTTP2_NO_ERROR);
  const uint8_t *data;
  nghttp2_ssize m = nghttp2_session_mem_send2(c, &data);
  if (m > 0) {
    yk_puts(&l, "client sends ");
    yk_hex(&l, data, m);
    yk_puts(&l, "\n");
    nghttp2_session_mem_recv2(sv, data, (size_t)m);
  }
  nghttp2_session_del(c);
  nghttp2_session_del(sv);
  return l.n;
}
