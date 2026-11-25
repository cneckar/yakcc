// SPDX-License-Identifier: Apache-2.0
// Node's HTTP parser, llhttp (vendor/node/deps/llhttp), as one C function for the C front end's
// test (#1367): parse a stream in chunks, every callback and the outcome written to a log.
#include <stdio.h>
#include <string.h>
#include "llhttp.h"

typedef struct {
  char *out;
  long cap, n;
} yk_log;

static void yk_put(llhttp_t *p, const char *tag, const char *at, size_t len) {
  yk_log *l = (yk_log *)p->data;
  int k = snprintf(l->out + l->n, (size_t)(l->cap - l->n), "%s", tag);
  if (k > 0) l->n += k;
  if (at != NULL) {
    l->n += snprintf(l->out + l->n, (size_t)(l->cap - l->n), "(%zu)", len);
    for (size_t i = 0; i < len && l->n < l->cap - 1; i++) l->out[l->n++] = at[i];
  }
  if (l->n < l->cap - 1) l->out[l->n++] = ';';
}

#define YK_DATA(name) \
  static int yk_##name(llhttp_t *p, const char *at, size_t len) { yk_put(p, #name, at, len); return 0; }
#define YK_EVENT(name) \
  static int yk_##name(llhttp_t *p) { yk_put(p, #name, NULL, 0); return 0; }
YK_DATA(url)
YK_DATA(status)
YK_DATA(method)
YK_DATA(version)
YK_DATA(header_field)
YK_DATA(header_value)
YK_DATA(chunk_extension_name)
YK_DATA(chunk_extension_value)
YK_DATA(body)
YK_EVENT(message_begin)
YK_EVENT(url_complete)
YK_EVENT(status_complete)
YK_EVENT(method_complete)
YK_EVENT(version_complete)
YK_EVENT(header_field_complete)
YK_EVENT(header_value_complete)
YK_EVENT(chunk_header)
YK_EVENT(chunk_complete)
YK_EVENT(message_complete)
YK_EVENT(reset)

static int yk_headers_complete(llhttp_t *p) {
  yk_log *l = (yk_log *)p->data;
  l->n += snprintf(l->out + l->n, (size_t)(l->cap - l->n),
                   "headers %d.%d m=%d s=%d f=%x cl=%llu ka=%d up=%d;", p->http_major,
                   p->http_minor, p->method, p->status_code, p->flags,
                   (unsigned long long)p->content_length, llhttp_should_keep_alive(p),
                   p->upgrade);
  return 0;
}

/*
 * Parse `in` (n bytes) as a request (type 1), a response (2) or either (0), `step` bytes at a
 * time, with the lenient flags of `lenient` (bit i: the i-th setter), then finish. The log's
 * length.
 */
long yk_http(const char *in, long n, int type, int step, int lenient, char *out, long cap) {
  llhttp_settings_t s;
  llhttp_settings_init(&s);
  s.on_message_begin = yk_message_begin;
  s.on_url = yk_url;
  s.on_status = yk_status;
  s.on_method = yk_method;
  s.on_version = yk_version;
  s.on_header_field = yk_header_field;
  s.on_header_value = yk_header_value;
  s.on_chunk_extension_name = yk_chunk_extension_name;
  s.on_chunk_extension_value = yk_chunk_extension_value;
  s.on_headers_complete = yk_headers_complete;
  s.on_body = yk_body;
  s.on_message_complete = yk_message_complete;
  s.on_url_complete = yk_url_complete;
  s.on_status_complete = yk_status_complete;
  s.on_method_complete = yk_method_complete;
  s.on_version_complete = yk_version_complete;
  s.on_header_field_complete = yk_header_field_complete;
  s.on_header_value_complete = yk_header_value_complete;
  s.on_chunk_header = yk_chunk_header;
  s.on_chunk_complete = yk_chunk_complete;
  s.on_reset = yk_reset;
  llhttp_t p;
  llhttp_init(&p, (llhttp_type_t)type, &s);
  yk_log l = {out, cap, 0};
  p.data = &l;
  void (*const set[])(llhttp_t *, int) = {
      llhttp_set_lenient_headers,           llhttp_set_lenient_chunked_length,
      llhttp_set_lenient_keep_alive,        llhttp_set_lenient_transfer_encoding,
      llhttp_set_lenient_version,           llhttp_set_lenient_data_after_close,
      llhttp_set_lenient_optional_lf_after_cr, llhttp_set_lenient_optional_cr_before_lf,
      llhttp_set_lenient_optional_crlf_after_chunk, llhttp_set_lenient_spaces_after_chunk_size,
      llhttp_set_lenient_header_value_relaxed};
  for (int i = 0; i < (int)(sizeof set / sizeof set[0]); i++)
    if (lenient & (1 << i)) set[i](&p, 1);
  llhttp_errno_t e = HPE_OK;
  for (long at = 0; at < n && e == HPE_OK;) {
    long k = step <= 0 || n - at < step ? n - at : step;
    e = llhttp_execute(&p, in + at, (size_t)k);
    at += k;
  }
  if (e == HPE_OK) e = llhttp_finish(&p);
  const char *pos = llhttp_get_error_pos(&p);
  l.n += snprintf(l.out + l.n, (size_t)(l.cap - l.n), "end %s %s %ld", llhttp_errno_name(e),
                  e == HPE_OK ? "" : llhttp_get_error_reason(&p),
                  e == HPE_OK || pos == NULL ? -1L : (long)(pos - in));
  return l.n;
}
