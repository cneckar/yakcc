/* SPDX-License-Identifier: Apache-2.0 */
/* Statics (#1369): a global array, a static local, a table of function pointers, string literals'
   addresses, and a static pointing into another; each call changes and reads them. */
static int counter(void) {
  static int n = 10;
  return ++n;
}
int table[5] = {3, 1, 4, 1, 5};
static const char *names[] = {"zero", "one", "two"};
static int twice(int x) { return 2 * x; }
static int thrice(int x) { return 3 * x; }
static int (*const ops[2])(int) = {twice, thrice};
struct pair {
  int *p;
  long long q;
  double d;
  unsigned char b;
};
static struct pair pr = {&table[2], -5000000000LL, 2.5, 200};
long long statics_sum(int i, int k) {
  table[i % 5] += k;
  long long s = 0;
  for (int j = 0; j < 5; j++) s += table[j];
  return s * 1000 + counter() + ops[k & 1](i) + names[i % 3][1] + *pr.p + pr.q % 1000 +
         (long long)(pr.d * 2) + pr.b;
}
