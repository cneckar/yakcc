// What V8's heap setup needs of C++ statics and offsetof (DEC-DUC-V8-OBJECT-MODEL-001):
// - a constexpr std::initializer_list of records (setup-heap-internal.cc's string tables), read
//   by a range-for;
// - offsetof through a macro, of a nested member and an array element, in functions of the same
//   name in different namespaces (Isolate::FromHeap's OFFSET_OF(Isolate, heap_)).
#include <cstddef>
#include <cstring>
#include <initializer_list>

enum class Root : unsigned short { kA = 3, kB = 7, kC = 11 };
struct Init {
  const char* contents;
  Root index;
};
constexpr std::initializer_list<Init> kTable{{"alpha", Root::kA}, {"be", Root::kB}, {"", Root::kC}};
constexpr std::initializer_list<int> kEmpty{};

int table_sum() {
  int n = 0;
  for (const Init& e : kTable) n += static_cast<int>(e.index) * 100 + static_cast<int>(strlen(e.contents));
  return n + static_cast<int>(kTable.size()) * 1000 + static_cast<int>(kEmpty.size());
}

namespace a {
struct S {
  int x;
  struct {
    char c;
    double d;
  } in;
  int arr[4];
};
}  // namespace a
#define OFF(t, f) offsetof(t, f)
namespace b {
int g(int i) { return static_cast<int>(OFF(a::S, in.d) + offsetof(a::S, arr[2])) + i; }
}  // namespace b
int g(long i) { return static_cast<int>(offsetof(a::S, x) + offsetof(a::S, in)) + static_cast<int>(i); }
int offsets(int i) { return b::g(i) * 1000 + g(static_cast<long>(i)); }

// V8's flags (src/flags/flag-definitions.h): a read-only flag is a static constexpr member of
// FlagValues, read through the object as the others are (`v8_flags.single_generation`).
template <typename T>
struct FlagValue {
  constexpr FlagValue(T v) : value_(v) {}
  constexpr operator T() const { return value_; }
  T value_;
};
struct FlagValues {
  FlagValue<int> full{5};
  static constexpr FlagValue<bool> single_generation{true};
  static constexpr FlagValue<int> limit{40};
};
FlagValues v8_flags;
int flags_read(int i) {
  if (v8_flags.single_generation) return v8_flags.full + v8_flags.limit + i;
  return -1;
}
