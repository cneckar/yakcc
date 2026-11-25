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

}
