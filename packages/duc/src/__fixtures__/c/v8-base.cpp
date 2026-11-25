// V8's src/base bit and division helpers (V8 12.4, vendored), as C functions to shave (#1364):
// templates (CountPopulation<T>, the division magic numbers' instances), constexpr functions,
// overflow helpers with an out parameter, a struct returned by value. V8's portable C is chosen
// over compiler intrinsics (its V8_HAS_BUILTIN_* switches off), on both sides of the test.
#include "include/v8config.h"
#undef V8_HAS_BUILTIN_CLZ
#undef V8_HAS_BUILTIN_CTZ
#undef V8_HAS_BUILTIN_POPCOUNT
#undef V8_HAS_BUILTIN_SADD_OVERFLOW
#undef V8_HAS_BUILTIN_SSUB_OVERFLOW
#undef V8_HAS_BUILTIN_SMUL_OVERFLOW
#define V8_HAS_BUILTIN_CLZ 0
#define V8_HAS_BUILTIN_CTZ 0
#define V8_HAS_BUILTIN_POPCOUNT 0
#define V8_HAS_BUILTIN_SADD_OVERFLOW 0
#define V8_HAS_BUILTIN_SSUB_OVERFLOW 0
#define V8_HAS_BUILTIN_SMUL_OVERFLOW 0
#include "src/base/bits.cc"
#include "src/base/division-by-constant.cc"

namespace b = v8::base::bits;

extern "C" {
int64_t yk_popcount32(int64_t x) { return b::CountPopulation(static_cast<uint32_t>(x)); }
int64_t yk_popcount64(int64_t x) { return b::CountPopulation(static_cast<uint64_t>(x)); }
int64_t yk_popcount8(int64_t x) { return b::CountPopulation(static_cast<uint8_t>(x)); }
int64_t yk_clz32(int64_t x) { return b::CountLeadingZeros32(static_cast<uint32_t>(x)); }
int64_t yk_clz64(int64_t x) { return b::CountLeadingZeros64(static_cast<uint64_t>(x)); }
int64_t yk_ctz32(int64_t x) { return b::CountTrailingZeros32(static_cast<uint32_t>(x)); }
int64_t yk_ctz64(int64_t x) { return b::CountTrailingZeros64(static_cast<uint64_t>(x)); }
int64_t yk_is_pow2(int64_t x) { return b::IsPowerOfTwo(static_cast<uint64_t>(x)); }
int64_t yk_round_up_pow2_32(int64_t x) { return b::RoundUpToPowerOfTwo32(static_cast<uint32_t>(x) >> 1); }
int64_t yk_round_up_pow2_64(int64_t x) { return static_cast<int64_t>(b::RoundUpToPowerOfTwo64(static_cast<uint64_t>(x) >> 1)); }
int64_t yk_rotr32(int64_t x, int64_t s) { return b::RotateRight32(static_cast<uint32_t>(x), static_cast<uint32_t>(s) & 31); }
int64_t yk_rotr64(int64_t x, int64_t s) { return static_cast<int64_t>(b::RotateRight64(static_cast<uint64_t>(x), static_cast<uint64_t>(s) & 63)); }
int64_t yk_add_overflow32(int64_t x, int64_t y) {
  int32_t v;
  bool o = b::SignedAddOverflow32(static_cast<int32_t>(x), static_cast<int32_t>(y), &v);
  return static_cast<int64_t>(v) * 2 + o;
}
int64_t yk_sub_overflow32(int64_t x, int64_t y) {
  int32_t v;
  bool o = b::SignedSubOverflow32(static_cast<int32_t>(x), static_cast<int32_t>(y), &v);
  return static_cast<int64_t>(v) * 2 + o;
}
int64_t yk_mul_overflow32(int64_t x, int64_t y) {
  int32_t v;
  bool o = b::SignedMulOverflow32(static_cast<int32_t>(x), static_cast<int32_t>(y), &v);
  return static_cast<int64_t>(v) * 2 + o;
}
int64_t yk_mul_high32(int64_t x, int64_t y) { return b::SignedMulHigh32(static_cast<int32_t>(x), static_cast<int32_t>(y)); }
int64_t yk_umul_high32(int64_t x, int64_t y) { return b::UnsignedMulHigh32(static_cast<uint32_t>(x), static_cast<uint32_t>(y)); }
int64_t yk_mul_high64(int64_t x, int64_t y) { return b::SignedMulHigh64(x, y); }
int64_t yk_umul_high64(int64_t x, int64_t y) { return static_cast<int64_t>(b::UnsignedMulHigh64(static_cast<uint64_t>(x), static_cast<uint64_t>(y))); }
int64_t yk_div32(int64_t x, int64_t y) { return b::SignedDiv32(static_cast<int32_t>(x), static_cast<int32_t>(y)); }
int64_t yk_mod32(int64_t x, int64_t y) { return b::SignedMod32(static_cast<int32_t>(x), static_cast<int32_t>(y)); }
int64_t yk_div64(int64_t x, int64_t y) { return b::SignedDiv64(x, y); }
int64_t yk_mod64(int64_t x, int64_t y) { return b::SignedMod64(x, y); }
int64_t yk_sat_add64(int64_t x, int64_t y) { return b::SignedSaturatedAdd64(x, y); }
int64_t yk_sat_sub64(int64_t x, int64_t y) { return b::SignedSaturatedSub64(x, y); }
// The magic numbers for a division by a constant: multiplier, shift and add, packed.
int64_t yk_signed_magic32(int64_t d) {
  auto m = v8::base::SignedDivisionByConstant(static_cast<uint32_t>(d));
  return static_cast<int64_t>(m.multiplier) * 1024 + m.shift * 2 + m.add;
}
int64_t yk_unsigned_magic32(int64_t d) {
  auto m = v8::base::UnsignedDivisionByConstant(static_cast<uint32_t>(d), 0);
  return static_cast<int64_t>(m.multiplier) * 1024 + m.shift * 2 + m.add;
}
int64_t yk_signed_magic64(int64_t d) {
  auto m = v8::base::SignedDivisionByConstant(static_cast<uint64_t>(d));
  return static_cast<int64_t>(m.multiplier ^ (static_cast<uint64_t>(m.shift) << 56) ^ m.add);
}
}
