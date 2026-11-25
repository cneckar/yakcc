// C++ classes for the C++ front end (#1364): methods with `this`, constructors with member
// initializers, destructors run at scope exit, references, virtual calls, operators, a lambda,
// and new/delete. Each yk_* function is a C entry the test calls, natively and shaved.
#include <stddef.h>

namespace yk {

struct Point {
  int x, y;
  Point(int x0, int y0) : x(x0), y(y0) {}
  int dot(const Point &o) const { return x * o.x + y * o.y; }
  Point operator+(const Point &o) const { return Point(x + o.x, y + o.y); }
  void scale(int k) { x *= k; y *= k; }
};

// A counter whose destructor writes back: destruction at scope exit, in reverse order.
struct Guard {
  int *log;
  int id;
  Guard(int *l, int i) : log(l), id(i) { *log = *log * 10 + id; }
  ~Guard() { *log = *log * 10 + id + 5; }
};

struct Shape {
  virtual ~Shape() {}
  virtual int area() const = 0;
  virtual int sides() const { return 0; }
};
struct Rect : Shape {
  int w, h;
  Rect(int w0, int h0) : w(w0), h(h0) {}
  int area() const override { return w * h; }
  int sides() const override { return 4; }
};
struct Square : Rect {
  explicit Square(int s) : Rect(s, s) {}
  int sides() const override { return 4 + 1000; }
};
struct Tri : Shape {
  int b, h;
  Tri(int b0, int h0) : b(b0), h(h0) {}
  int area() const override { return b * h / 2; }
};

static void bump(int &r, int by) { r += by; }

}  // namespace yk

namespace yk {
// A class template with a nested class, a constant static member, an anonymous union and
// default member initializers (the shapes of libstdc++'s std::string).
template <class T> struct Box {
  static constexpr bool is_signed = T(-1) < T(0);
  struct Hider {
    T *p;
    Hider(T *q) : p(q) {}
  };
  Hider hider;
  int used = 0;
  bool local = true;
  union {
    T buf[4];
    long cap;
  };
  Box(T *q) : hider(q) { buf[0] = T(); }
  T *data() { return local ? buf : hider.p; }
  int sign() const { return is_signed ? -1 : 1; }
};
using Word = int;

// C++17 and later forms: an inheriting and a delegating constructor, a static member function
// called through this, a trailing return type, a constexpr table built by a function.
struct Base {
  int v;
  Base(int a, int b) : v(a * 3 - b) {}
};
struct Derived : Base {
  using Base::Base;
  static int twice(int x) { return 2 * x; }
  int get() { return this->twice(v); }
};
struct Pair {
  int first;
  long second;
  Pair(int a) : Pair(a, -a) {}
  Pair(int a, long b) : first(a), second(b * 2) {}
};
auto add3(int x) -> int { return x + 3; }
struct Table {
  unsigned char v[64];
};
constexpr Table build() {
  Table t{};
  for (int i = 0; i < 64; i++) t.v[i] = (unsigned char)(i * 37 + 11);
  return t;
}
static constexpr Table table = build();
} // namespace yk

extern "C" {

int yk_point(int a, int b) {
  yk::Point p(a, b), q(b, -a);
  yk::Point s = p + q;
  s.scale(3);
  return s.dot(p) + q.x;
}

int yk_guards(int n) {
  int log = 0;
  {
    yk::Guard a(&log, 1);
    if (n > 0) {
      yk::Guard b(&log, 2);
      if (n > 5) return log;
    }
    yk::Guard c(&log, 3);
  }
  return log;
}

int yk_shapes(int a, int b) {
  yk::Shape *shapes[3] = {new yk::Rect(a, b), new yk::Square(a), new yk::Tri(a, b)};
  int total = 0;
  for (int i = 0; i < 3; i++) total += shapes[i]->area() * 7 + shapes[i]->sides();
  for (int i = 0; i < 3; i++) delete shapes[i];
  return total;
}

int yk_refs(int a, int b) {
  int x = a;
  int &r = x;
  yk::bump(r, b);
  auto add = [&x, b](int k) { x += k * b; return x; };
  add(2);
  return add(a) + r;
}

int yk_box(int a, int b) {
  int out = b;
  yk::Box<int> bi(&out);
  yk::Box<unsigned> bu(nullptr);
  bi.buf[1] = a;
  yk::Word w = bi.data()[1] + bi.data()[0] + bi.used;
  bi.local = a > b;
  w += *bi.data();
  bi.cap = 0;
  return w * bi.sign() + bu.sign() * 1000 + bu.used + int(bu.buf[0]);
}

int yk_modern(int a, int b) {
  int arr[5] = {a, b, a - b, 7, -1};
  int sum = 0;
  for (int x : arr) {
    if (x < 0) continue;
    sum += x;
  }
  if (int r = a % 7; r > 2) sum += r;
  yk::Pair p(b);
  auto [f, s] = p;
  sum += f + int(s);
  int out = 0;
  if (__builtin_mul_overflow(a, b * 100000, &out)) sum += 1;
  else sum += out & 0xff;
  unsigned char small = 0;
  sum += __builtin_add_overflow(a & 0xff, 200, &small) ? 1000 : small;
  yk::Derived d(a, b);
  return sum + d.get() + yk::add3(a) + yk::table.v[(a & 63)];
}

}
