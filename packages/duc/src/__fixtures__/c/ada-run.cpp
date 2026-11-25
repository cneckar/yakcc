// SPDX-License-Identifier: Apache-2.0
// ada (vendor/ada, Node's URL parser) as a C function for the C++ front end's test (#1367): a URL
// parsed, against a base when one is given, and each of its components written out.
#include "ada.cpp"
#include <cstring>

namespace {
int put(char *out, int at, int cap, std::string_view s) {
  for (char c : s) {
    if (at < cap) out[at] = c;
    at++;
  }
  if (at < cap) out[at] = '|';
  return at + 1;
}
} // namespace

// The components of `in` parsed against `base` (none when `bn` is negative), `|`-separated, in
// `out`; their length, or -1 when the URL does not parse.
extern "C" int yk_url(const char *in, int n, const char *base, int bn, char *out, int cap) {
  std::string_view b(base, bn < 0 ? 0 : size_t(bn));
  auto u = ada::parse<ada::url_aggregator>(std::string_view(in, size_t(n)), nullptr);
  if (bn >= 0) {
    auto parent = ada::parse<ada::url_aggregator>(b, nullptr);
    if (!parent) return -2;
    u = ada::parse<ada::url_aggregator>(std::string_view(in, size_t(n)), &*parent);
  }
  if (!u) return -1;
  int at = 0;
  at = put(out, at, cap, u->get_href());
  at = put(out, at, cap, u->get_origin());
  at = put(out, at, cap, u->get_protocol());
  at = put(out, at, cap, u->get_username());
  at = put(out, at, cap, u->get_password());
  at = put(out, at, cap, u->get_host());
  at = put(out, at, cap, u->get_hostname());
  at = put(out, at, cap, u->get_port());
  at = put(out, at, cap, u->get_pathname());
  at = put(out, at, cap, u->get_search());
  at = put(out, at, cap, u->get_hash());
  return at;
}
