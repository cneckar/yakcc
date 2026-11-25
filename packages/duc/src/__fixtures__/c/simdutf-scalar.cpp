// simdutf's scalar UTF-8/UTF-16 paths, as C functions to shave (#1364). The scalar functions are
// in an anonymous namespace of simdutf.cpp, so this unit includes it.
#include "simdutf.cpp"

using simdutf::endianness;
namespace sc = simdutf::scalar;

extern "C" {
int yk_utf8_validate(const char *s, size_t n) { return sc::utf8::validate(s, n); }
size_t yk_utf8_count(const char *s, size_t n) { return sc::utf8::count_code_points(s, n); }
size_t yk_utf16_length_from_utf8(const char *s, size_t n) { return sc::utf8::utf16_length_from_utf8(s, n); }
size_t yk_utf8_to_utf16le(const char *s, size_t n, char16_t *o) { return sc::utf8_to_utf16::convert<endianness::LITTLE>(s, n, o); }
size_t yk_utf8_to_utf16be(const char *s, size_t n, char16_t *o) { return sc::utf8_to_utf16::convert<endianness::BIG>(s, n, o); }
int yk_utf16le_validate(const char16_t *s, size_t n) { return sc::utf16::validate<endianness::LITTLE>(s, n); }
size_t yk_utf16le_count(const char16_t *s, size_t n) { return sc::utf16::count_code_points<endianness::LITTLE>(s, n); }
size_t yk_utf8_length_from_utf16le(const char16_t *s, size_t n) { return sc::utf16::utf8_length_from_utf16<endianness::LITTLE>(s, n); }
size_t yk_utf16le_to_utf8(const char16_t *s, size_t n, char *o) { return sc::utf16_to_utf8::convert<endianness::LITTLE>(s, n, o); }
size_t yk_utf16be_to_utf8(const char16_t *s, size_t n, char *o) { return sc::utf16_to_utf8::convert<endianness::BIG>(s, n, o); }
}
