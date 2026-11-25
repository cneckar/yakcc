/* SPDX-License-Identifier: Apache-2.0
 * Node's libuv (vendor/node/deps/uv, 1.51.0), its parts that compute (#1367): every error's name
 * and message (util.getSystemErrorName and getSystemErrorMap), IDNA to ASCII (punycode, as
 * uv_getaddrinfo applies it), and IPv4/IPv6 text to bytes and back. */
#include <stdio.h>
#include <string.h>
#include "uv.h"
#include "idna.h"

/* Each libuv error, `code name message` a line. */
long yk_uv_errors(char *out, long cap) {
  long n = 0;
#define YK_ERR(name, _)                                                                        \
  n += snprintf(out + n, (size_t)(cap - n), "%d %s %s\n", UV_##name, uv_err_name(UV_##name), \
                uv_strerror(UV_##name));
  UV_ERRNO_MAP(YK_ERR)
#undef YK_ERR
  /* An unknown code too. */
  char buf[64];
  n += snprintf(out + n, (size_t)(cap - n), "-9999 %s %s\n",
                uv_err_name_r(-9999, buf, sizeof buf), uv_strerror(-9999));
  return n;
}

/* A host name (UTF-8) to its ASCII form: the length written, or a negative error. */
long yk_uv_idna(const char *in, long n, char *out, long cap) {
  return (long)uv__idna_toascii(in, in + n, out, out + cap);
}

/* Text to an address of a family (4 or 6) and back: `rc text` (or `rc` on failure). */
long yk_uv_inet(int family, const char *text, char *out, long cap) {
  unsigned char a[16];
  int af = family == 6 ? AF_INET6 : AF_INET;
  int r = uv_inet_pton(af, text, a);
  if (r != 0) return snprintf(out, (size_t)cap, "%d", r);
  char t[64];
  int r2 = uv_inet_ntop(af, a, t, sizeof t);
  return snprintf(out, (size_t)cap, "0 %d %s", r2, r2 == 0 ? t : "");
}
