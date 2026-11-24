/* C's memory, for the C front end (#1363): pointers, &, *, [], ->, structs, arrays and unions by
 * clang's layout, string literals. Compiled natively with -fwrapv and shaved; both must agree. */
#include <stddef.h>
#include <stdint.h>

struct pt {
  char tag;
  double x;
  int v[3];
  union {
    int i;
    unsigned char b[4];
  } u;
  struct pt *next;
  short s;
};

/* qsort's comparators: by int value, and bytewise over a width passed through the argument. */
int yk_cmp_int(const void *a, const void *b) {
  int x = *(const int *)a, y = *(const int *)b;
  return (x > y) - (x < y);
}
int yk_cmp_bytes(const void *a, const void *b, void *w) {
  size_t n = *(size_t *)w;
  const unsigned char *p = a, *q = b;
  for (size_t i = 0; i < n; i++)
    if (p[i] != q[i]) return p[i] < q[i] ? -1 : 1;
  return 0;
}

/* An array of structs in the caller's memory, linked through ->, then walked. */
double yk_struct_walk(struct pt *ps, int n) {
  for (int i = 0; i < n; i++) {
    ps[i].tag = (char)(i * 37);
    ps[i].x = i * 1.5;
    ps[i].v[i % 3] = i;
    ps[i].u.i = i * 0x01020304;
    ps[i].next = i + 1 < n ? &ps[i + 1] : 0;
    ps[i].s = (short)(i * 1000);
  }
  double t = 0;
  for (struct pt *p = ps; p; p = p->next) t += p->x + p->v[0] + p->u.b[1] + p->tag + p->s;
  return t;
}

/* A local struct with a partial initializer (the rest is zero), modified through a pointer. */
int yk_local_struct(int a) {
  struct pt p = {1, 2.5, {a, 2}};
  struct pt *q = &p;
  q->v[2] += a;
  q->u.b[3] = (unsigned char)a;
  return p.v[0] + p.v[2] + (int)p.x + p.tag + p.u.i + (int)sizeof(struct pt);
}

/* String literals are constant memory. */
int yk_string_sum(int i) {
  const char *s = i & 1 ? "hello, world\n" : "\x7f\001abc\377";
  int t = 0;
  while (*s) t = t * 31 + *s++;
  return t;
}

/* A local array used through pointers, walked backward. */
int yk_local_array(int n) {
  int a[10];
  int *p = a;
  for (int i = 0; i < 10; i++) p[i] = i * n;
  int s = 0;
  for (int *q = a + 9; q > a; q--) s = s * 3 + *q;
  return s + *a;
}

/* Two addresses' distance, in elements. */
long yk_ptr_diff(int n) {
  int buf[64];
  int *p = buf + (n & 31);
  int *q = &buf[63];
  return q - p;
}

/* Locals whose address is taken. */
int yk_swap(int a, int b) {
  int x = a, y = b;
  int *px = &x, *py = &y;
  int t = *px;
  *px = *py;
  *py = t;
  return x * 1000 + y;
}

/* A char array initialized from a string, written, and summed through unsigned char. */
int yk_char_array(int k) {
  char s[16] = "abc";
  s[3] = (char)k;
  s[4] = (char)(k >> 8);
  const unsigned char *u = (const unsigned char *)s;
  int t = 0;
  for (int i = 0; i < 16; i++) t = t * 7 + u[i];
  return t;
}

/* Forward gotos: out of loops, to a cleanup label, to labels that nest and overlap. */
int yk_goto(int a, int b) {
  int t = 0;
  if (a < 0) goto negative;
  for (int i = 0; i < a % 50; i++) {
    t += i * b;
    if (t > 1000) goto big;
    if ((t & 7) == 3) goto odd;
  }
  t += 1;
odd:
  t = t * 3 + 1;
big:
  if (b == 7) goto done;
  t ^= 0x55;
  goto done;
negative:
  t = -a;
done:
  return t;
}

/* Module state: a file-scope static, a global table, pointers into them and a function pointer in
 * static initializers, and a static local; each call changes them, so a sequence of calls checks
 * that the state persists. */
static int counter = 5;
int yk_global_table[4] = {1, 2, 3, 4};
static int *ptrs[2] = {&yk_global_table[1], &counter};
static int (*cmp)(const void *, const void *) = yk_cmp_int;
static const char *greeting = "hi";
int yk_state(int a) {
  static int calls;
  calls++;
  counter += a;
  yk_global_table[a & 3] += counter;
  return counter * 100 + *ptrs[0] + *ptrs[1] + calls * 7 + cmp(&a, &counter) + greeting[1];
}
