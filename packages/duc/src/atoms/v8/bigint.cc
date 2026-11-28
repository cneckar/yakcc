// SPDX-License-Identifier: Apache-2.0
// V8's src/bigint as one unit, for the C++ front end to shave (#1516): its files as V8 builds them,
// on V8's portable digit_div (the standard headers first, then __x86_64__ undefined, so the
// x86-64 divq asm is not taken).
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>
#include <iostream>
#undef __x86_64__
// V8's CHECK as an abort, as the nbytes fixture defines Node's: its message is written through
// libstdc++'s std::cerr, outside this unit; the failure itself is the same.
#include "src/bigint/bigint-internal.h"
#undef CHECK
#define CHECK(cond) \
  if (!(cond)) abort();
#include "src/bigint/bigint-internal.cc"
#include "src/bigint/bitwise.cc"
#include "src/bigint/div-barrett.cc"
#include "src/bigint/div-burnikel.cc"
#include "src/bigint/div-helpers.cc"
#include "src/bigint/div-schoolbook.cc"
#include "src/bigint/fromstring.cc"
#include "src/bigint/mul-fft.cc"
#include "src/bigint/mul-karatsuba.cc"
#include "src/bigint/mul-schoolbook.cc"
#include "src/bigint/mul-toom.cc"
#include "src/bigint/tostring.cc"
#include "src/bigint/vector-arithmetic.cc"

// The processor V8's src/objects/bigint.cc makes (`bigint::Processor::New(new bigint::Platform())`),
// for the atoms' callers: V8's own call, as a function.
v8::bigint::Processor* yk_v8_bigint_processor() {
  return v8::bigint::Processor::New(new v8::bigint::Platform());
}
