// SPDX-License-Identifier: Apache-2.0
// Node's simdjson (vendor/node/deps/simdjson, 4.5.0) as Node's module loader reads a package.json
// with it (#1367, src/node_modules.cc): the on-demand parser over the padded text, each top-level
// field's key and type, a string unescaped, an object or array as its raw JSON, a number and a
// boolean as their values; or the error.
#include <cstdio>
#include <cstring>
#include "simdjson.h"
#include "simdjson.cpp"

extern "C" long yk_package_json(const char *in, long n, char *out, long cap) {
  static simdjson::ondemand::parser parser;
  long k = 0;
  auto put = [&](const char *s, size_t len) {
    for (size_t i = 0; i < len && k < cap - 1; i++) out[k++] = s[i];
  };
  auto puts_ = [&](const char *s) { put(s, std::strlen(s)); };
  simdjson::padded_string text(in, (size_t)n);
  simdjson::ondemand::document doc;
  auto error = parser.iterate(text).get(doc);
  if (error) {
    puts_("E ");
    puts_(simdjson::error_message(error));
    return k;
  }
  simdjson::ondemand::object obj;
  if ((error = doc.get_object().get(obj))) {
    puts_("E ");
    puts_(simdjson::error_message(error));
    return k;
  }
  for (auto field : obj) {
    std::string_view key;
    if ((error = field.unescaped_key().get(key))) break;
    put(key.data(), key.size());
    simdjson::ondemand::json_type t;
    if ((error = field.value().type().get(t))) break;
    char b[64];
    switch (t) {
      case simdjson::ondemand::json_type::string: {
        std::string_view s;
        if ((error = field.value().get_string().get(s))) break;
        puts_(" S ");
        put(s.data(), s.size());
        break;
      }
      case simdjson::ondemand::json_type::object:
      case simdjson::ondemand::json_type::array: {
        std::string_view raw;
        if ((error = field.value().raw_json().get(raw))) break;
        puts_(t == simdjson::ondemand::json_type::object ? " O " : " A ");
        put(raw.data(), raw.size());
        break;
      }
      case simdjson::ondemand::json_type::number: {
        double d;
        if ((error = field.value().get_double().get(d))) break;
        std::snprintf(b, sizeof b, " N %.17g", d);
        puts_(b);
        break;
      }
      case simdjson::ondemand::json_type::boolean: {
        bool v;
        if ((error = field.value().get_bool().get(v))) break;
        puts_(v ? " B true" : " B false");
        break;
      }
      default:
        puts_(" null");
    }
    if (error) break;
    puts_("\n");
  }
  if (error) {
    puts_("E ");
    puts_(simdjson::error_message(error));
  }
  return k;
}
