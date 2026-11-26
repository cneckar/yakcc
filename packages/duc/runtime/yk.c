// SPDX-License-Identifier: Apache-2.0
/*
 * The yakcc native runtime (#1292, DEC-DUC-NATIVE-RUNTIME-001): JavaScript's values and operations
 * for the native lowering of graphs that are not in the typed subset. It is compiled for each target
 * by the same LLVM toolchain (clang) and linked like any C library.
 *
 * Values are NaN-boxed into one 64-bit word, as JavaScript engines box them:
 *   - a double is itself (every NaN canonical: 0x7FF8000000000000);
 *   - every other value has the top 16 bits 0xFFF9..0xFFFC, a space no canonical double uses:
 *       0xFFF9: undefined (0), null (1), false (2), true (3)
 *       0xFFFA: a string  (pointer to yk_string)
 *       0xFFFB: an array  (pointer to yk_array)
 *       0xFFFC: an object (pointer to yk_object: own properties in insertion order)
 *       0xFFFD: a function (pointer to yk_closure: its code and the values it captures)
 *       0xFFFE: the runtime's own (an iterator), never a program's value
 *       0xFFFF: a BigInt  (pointer to yk_bigint: a sign and 32-bit limbs)
 * Strings are UTF-16 code units, as JavaScript's are. Memory is allocated and not freed: a collector
 * is a later slice.
 *
 * Every operation follows ECMA-262 for the values it covers: ToNumber, ToString (the shortest digits
 * that round-trip), ToPrimitive for arrays (join), +, the arithmetic and relational operators, == and
 * ===, typeof, truthiness, `.length`, indexing, and the string and array methods listed below.
 */
#ifdef YK_NOLIBC
/* No C library: Linux's system calls and the runtime's own functions (#1361 P1). */
#include "nolibc.h"
#define YK_GC 1
#else
#define _GNU_SOURCE /* ucontext: an async function's or a generator's own stack (#1295) */
#include <math.h>
#include <setjmp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <ucontext.h>
#include <unistd.h>
#if defined(__linux__)
#include <link.h>
#include <pthread.h>
#include <sys/mman.h>
#define YK_GC 1
#else
#define YK_GC 0
#endif
#endif

typedef uint64_t yk;

typedef struct {
  uint32_t len;
  uint16_t units[];
} yk_string;

typedef struct {
  uint32_t len, cap;
  yk *items;
  yk props; /* its non-index properties (an object: an exec result's index, input, groups), or 0 */
  uint8_t *holes;    /* a bit per index it does not have ([, a], new Array(n), delete), or NULL */
  uint32_t holes_n;  /* bytes in holes */
} yk_array;

typedef struct {
  uint32_t len, cap;
  yk *keys; /* strings */
  yk *values;
  int32_t error; /* made by Error / TypeError / …: its ToString is Error.prototype.toString's */
  int32_t kind;  /* 0 a plain object; 1 a Map, 2 a Set: their entries in `entries`; 3 a RegExp;
                    4 a Promise, 5 a generator: their state in `ext` */
  yk proto;      /* the object it inherits from (a class's prototype), or 0 */
  yk *regex;     /* kind 3, a RegExp: its source, flags, matcher, and group names */
  yk_array *entries; /* a Map's [key, value] pairs, a Set's values, in insertion order */
  void *ext;         /* kind 4: its promise state; kind 5: its coroutine */
  void *privates;    /* its private members (#1330): a yk_object no enumeration sees, or NULL */
  uint32_t *index;   /* with 8 keys or more: each key's position + 1, by its hash; NULL to rebuild */
  uint32_t index_cap;
  uint32_t digit_keys; /* 1 once a key starting with a digit was added (an index's may be one); 2
                          too once one was not an index below 128 */
  uint64_t small_ints[2]; /* the indices below 128 a key was added for (a bit stays when deleted) */
  yk_array *hidden;       /* its non-enumerable own keys (Object.defineProperty's), or NULL */
} yk_object;

/* A BigInt: a sign and a magnitude, 32-bit limbs least significant first, no zero limb on top. */
typedef struct {
  int32_t neg;
  uint32_t len;
  uint32_t d[];
} yk_bigint;

/* Every function has one calling convention: the closure, the receiver, the arguments. */
typedef yk (*yk_code)(void *closure, yk self, uint64_t argc, const yk *argv);
typedef struct {
  yk_code code;
  int32_t has_this;  /* a `function` (1) takes the receiver; an arrow (0) does not */
  int32_t is_class;  /* a class: called only with `new` */
  yk props;          /* its own properties (an object), or 0 until one is written */
  yk class_self;     /* for a class's member (and closures inside it): the class, or 0 */
  yk parent;         /* a derived class: the class it extends (its statics' fallback), or 0 */
  int32_t home_static; /* a static member (or a closure inside one): `super` is the parent itself */
  int32_t mode;      /* 0 a function; 1 async: a call runs it as a coroutine, giving a promise;
                        2 a generator: a call gives the generator object (#1295) */
  uint32_t nfields;  /* a class: its instance fields, defined on each instance it makes (#1330) */
  yk *field_keys;
  yk *field_inits;   /* each a method: run with the instance as its receiver, its result the value */
  uint8_t *field_kind; /* 0 a field, 1 a private field, 2 a private method, 3 a private getter,
                          4 a private setter: the private methods and accessors first */
  yk outer;          /* a class: the class whose member made it, for private names (#1330), or 0 */
  uint32_t npriv;    /* a class: the private names it declares, and its key for each */
  yk *priv_names;
  yk *priv_keys;
  yk fname;          /* its name (a string), or 0: "" — read as its own `name` unless one is written */
  int32_t flen;      /* its parameter count, its own `length` unless one is written */
  uint32_t n;
  yk captures[];
} yk_closure;

#define TAG(v) ((v) >> 48)
#define T_SPECIAL 0xFFF9u
#define T_STRING 0xFFFAu
#define T_ARRAY 0xFFFBu
#define T_OBJECT 0xFFFCu
#define T_CLOSURE 0xFFFDu
#define T_INTERNAL 0xFFFEu
#define T_BIGINT 0xFFFFu
#define PTR(v) ((void *)(uintptr_t)((v) & 0x0000FFFFFFFFFFFFull))
#define BOX(tag, p) (((yk)(tag) << 48) | (yk)(uintptr_t)(p))

const yk YK_UNDEFINED = ((yk)T_SPECIAL << 48) | 0;
const yk YK_NULL = ((yk)T_SPECIAL << 48) | 1;
const yk YK_FALSE = ((yk)T_SPECIAL << 48) | 2;
const yk YK_TRUE = ((yk)T_SPECIAL << 48) | 3;

static int is_number(yk v) { return TAG(v) < T_SPECIAL; }
static int is_string(yk v) { return TAG(v) == T_STRING; }
static int is_array(yk v) { return TAG(v) == T_ARRAY; }
static int is_object(yk v) { return TAG(v) == T_OBJECT; }
static int is_closure(yk v) { return TAG(v) == T_CLOSURE; }
static int is_bigint(yk v) { return TAG(v) == T_BIGINT; }
/* Anything that is not a primitive. */
static int is_reference(yk v) { return is_array(v) || is_object(v) || is_closure(v); }
static int is_bool(yk v) { return v == YK_TRUE || v == YK_FALSE; }
static int is_nullish(yk v) { return v == YK_UNDEFINED || v == YK_NULL; }

static double num(yk v) {
  double d;
  memcpy(&d, &v, 8);
  return d;
}

yk yk_number(double d) {
  yk v;
  if (d != d) return 0x7FF8000000000000ull;
  memcpy(&v, &d, 8);
  return v;
}

yk yk_bool(int b) { return b ? YK_TRUE : YK_FALSE; }

/* Memory the runtime never frees (there is no collector yet): bumped out of zeroed chunks, 16-byte
   aligned. A large request has a chunk of its own. */
/* --- The heap and its collector (#1361 P1) ---------------------------------------------------
 *
 * Every value the runtime makes is allocated here, zeroed. On Linux it is a conservative mark-sweep
 * collector: blocks of size classes in 64 KiB pages of one reserved range (a block of more than
 * half a page takes whole pages); the roots are the native stack (and a suspended main stack while
 * a coroutine runs), the registers, and the writable segments of the program; each marked block is
 * scanned whole. A word is a pointer when it is an address in the heap, or a boxed value (a tag
 * at or above T_STRING) whose payload is one; any address inside a block keeps it (one past its end
 * too: a block is a byte longer than asked). Nothing moves. Elsewhere, memory is never freed.
 */
static void *bump(size_t n) {
  static uint8_t *chunk = NULL;
  static size_t left = 0;
  n = (n + 15) & ~(size_t)15;
  if (n > (1u << 16)) {
    void *p = calloc(1, n);
    if (p == NULL) abort();
    return p;
  }
  if (n > left) {
    chunk = calloc(1, 1u << 20);
    if (chunk == NULL) abort();
    left = 1u << 20;
  }
  void *p = chunk;
  chunk += n;
  left -= n;
  return p;
}
#if YK_GC
#define GC_PAGE_SHIFT 16
#define GC_PAGE ((size_t)1 << GC_PAGE_SHIFT)
#define GC_LARGE (GC_PAGE / 2)
static const uint32_t gc_sizes[] = {16,   32,   48,   64,   80,   96,    112,   128,   160,  192,
                                    224,  256,  320,  384,  448,  512,   640,   768,   896,  1024,
                                    1280, 1536, 1792, 2048, 2560, 3072,  3584,  4096,  5120, 6144,
                                    7168, 8192, 10240, 12288, 16384, 20480, 24576, 32768};
#define GC_NCLASS (sizeof gc_sizes / sizeof gc_sizes[0])
typedef struct {
  uint8_t kind; /* 0 free, 1 a page of small blocks, 2 a large block's first page, 3 its others */
  uint8_t cls;
  uint32_t n;   /* small: its blocks; large, first: its pages; large, other: back to the first */
  uint64_t used[64], mark[64];
} gc_page;
typedef struct {
  size_t start, len;
} gc_run;
static uint8_t *gc_heap = NULL;
static gc_page *gc_pages = NULL;
static size_t gc_npages = 0, gc_top = 0;
static gc_run *gc_runs = NULL;
static size_t gc_nruns = 0, gc_capruns = 0;
static void *gc_free[GC_NCLASS];
/* A block's index in its page: the offset times its class's reciprocal (exact below GC_PAGE), not a
   division. */
static uint64_t gc_recip[GC_NCLASS];
static size_t gc_since = 0, gc_threshold = (size_t)16 << 20, gc_floor = (size_t)16 << 20;
static int gc_state = 0; /* 0 not yet set up, 1 collecting, 2 allocating only, 3 never (no heap) */
static uintptr_t gc_stack_top = 0;
/* While a coroutine runs, where the main stack was left (its frames above are live). */
static uintptr_t gc_main_sp = 0;
static int gc_in_coroutine(void);
static void gc_report(void);
static uint8_t gc_class_of[GC_LARGE / 16 + 1];

static void gc_setup(void) {
  gc_state = 3;
  size_t sizes[] = {sizeof(void *) == 8 ? (size_t)1 << 36 : (size_t)1 << 30, (size_t)1 << 32,
                    (size_t)1 << 30, (size_t)1 << 28};
  for (int i = 0; i < 4; i++) {
    size_t sz = sizes[i];
    if (sizeof(void *) == 4 && sz > ((size_t)1 << 30)) continue;
    void *h = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
    if (h == MAP_FAILED) continue;
    size_t np = sz >> GC_PAGE_SHIFT;
    void *d = mmap(NULL, np * sizeof(gc_page), PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
    if (d == MAP_FAILED) {
      munmap(h, sz);
      continue;
    }
    gc_heap = h;
    gc_pages = d;
    gc_npages = np;
    gc_state = 2;
    break;
  }
  for (uint32_t c = 0, sz = 16; sz <= GC_LARGE; sz += 16) {
    while (gc_sizes[c] < sz) c++;
    gc_class_of[sz / 16] = (uint8_t)c;
  }
  for (uint32_t c = 0; c < GC_NCLASS; c++) gc_recip[c] = ((uint64_t)1 << 32) / gc_sizes[c] + 1;
  /* YK_GC_STRESS: collect every 64 KiB, so a value the roots miss is found by the tests. */
  const char *stress = getenv("YK_GC_STRESS");
  if (stress != NULL && stress[0] == '1') gc_threshold = gc_floor = (size_t)1 << 16;
  if (getenv("YK_GC_STATS") != NULL) atexit(gc_report);
#ifdef YK_NOLIBC
  /* The stack _start was entered with: every frame is below it. */
  if (gc_state == 2 && yk_nolibc_stack_top != 0) {
    gc_stack_top = yk_nolibc_stack_top;
    gc_state = 1;
  }
#else
  pthread_attr_t at;
  void *addr;
  size_t size;
  if (gc_state == 2 && pthread_getattr_np(pthread_self(), &at) == 0) {
    if (pthread_attr_getstack(&at, &addr, &size) == 0) {
      gc_stack_top = (uintptr_t)addr + size;
      gc_state = 1;
    }
    pthread_attr_destroy(&at);
  }
#endif
}

/* k contiguous pages: a freed run that fits, else new ones. *fresh: never used (zero). */
static size_t gc_get_pages(size_t k, int *fresh) {
  for (size_t i = 0; i < gc_nruns; i++)
    if (gc_runs[i].len >= k) {
      size_t at = gc_runs[i].start;
      gc_runs[i].start += k;
      gc_runs[i].len -= k;
      if (gc_runs[i].len == 0) gc_runs[i] = gc_runs[--gc_nruns];
      *fresh = 0;
      return at;
    }
  if (gc_top + k > gc_npages) {
    fputs("out of memory\n", stderr);
    exit(71);
  }
  size_t at = gc_top;
  gc_top += k;
  *fresh = 1;
  return at;
}
static void gc_put_pages(size_t start, size_t k) {
  for (size_t i = 0; i < k; i++) gc_pages[start + i].kind = 0;
  if (gc_nruns == gc_capruns) {
    gc_capruns = gc_capruns == 0 ? 64 : gc_capruns * 2;
    gc_runs = realloc(gc_runs, gc_capruns * sizeof(gc_run));
    if (gc_runs == NULL) abort();
  }
  gc_runs[gc_nruns++] = (gc_run){start, k};
}
static void gc_collect(void);
static void gc_report(void);

/* Anything but a small block from a free list while no collection is due: set-up, collection, a
   fresh page, a large block. */
static __attribute__((noinline)) void *alloc_slow(size_t n) {
  if (gc_state == 0) gc_setup();
  if (gc_state == 3) return bump(n);
  if (gc_state == 1 && gc_since >= gc_threshold) gc_collect();
  n += 1; /* one past the end is inside */
  if (n > GC_LARGE) {
    size_t k = (n + GC_PAGE - 1) >> GC_PAGE_SHIFT;
    int fresh;
    size_t at = gc_get_pages(k, &fresh);
    gc_page *g = &gc_pages[at];
    g->kind = 2;
    g->n = (uint32_t)k;
    g->used[0] = 1;
    for (size_t i = 1; i < k; i++) {
      gc_pages[at + i].kind = 3;
      gc_pages[at + i].n = (uint32_t)i;
    }
    uint8_t *p = gc_heap + (at << GC_PAGE_SHIFT);
    if (!fresh) memset(p, 0, k << GC_PAGE_SHIFT);
    gc_since += k << GC_PAGE_SHIFT;
    return p;
  }
  uint32_t c = gc_class_of[(n + 15) / 16];
  uint32_t size = gc_sizes[c];
  void *p = gc_free[c];
  if (p == NULL) {
    int fresh;
    size_t at = gc_get_pages(1, &fresh);
    gc_page *g = &gc_pages[at];
    g->kind = 1;
    g->cls = (uint8_t)c;
    g->n = (uint32_t)(GC_PAGE / size);
    memset(g->used, 0, sizeof g->used);
    uint8_t *base = gc_heap + (at << GC_PAGE_SHIFT);
    for (uint32_t b = g->n; b-- > 0;) {
      *(void **)(base + (size_t)b * size) = gc_free[c];
      gc_free[c] = base + (size_t)b * size;
    }
    p = gc_free[c];
  }
  gc_free[c] = *(void **)p;
  size_t off = (uint8_t *)p - gc_heap;
  gc_page *g = &gc_pages[off >> GC_PAGE_SHIFT];
  uint32_t b = (uint32_t)(((off & (GC_PAGE - 1)) * gc_recip[c]) >> 32);
  g->used[b >> 6] |= (uint64_t)1 << (b & 63);
  memset(p, 0, size);
  gc_since += size;
  return p;
}
/* A block of at least n bytes, zeroed: most often a small one from its class's free list, here (a
   leaf, no frame); anything else alloc_slow's. */
static void *alloc(size_t n) {
  size_t m = n + 1; /* one past the end is inside */
  if ((gc_state == 2 || (gc_state == 1 && gc_since < gc_threshold)) && m <= GC_LARGE) {
    uint32_t c = gc_class_of[(m + 15) / 16];
    uint8_t *p = gc_free[c];
    if (p != NULL) {
      uint32_t size = gc_sizes[c];
      gc_free[c] = *(void **)p;
      size_t off = (size_t)(p - gc_heap);
      gc_page *g = &gc_pages[off >> GC_PAGE_SHIFT];
      uint32_t b = (uint32_t)(((off & (GC_PAGE - 1)) * gc_recip[c]) >> 32);
      g->used[b >> 6] |= (uint64_t)1 << (b & 63);
      memset(p, 0, size);
      gc_since += size;
      return p;
    }
  }
  return alloc_slow(n);
}

/* Marking: an explicit stack of blocks to scan. */
static struct {
  uint8_t *p;
  size_t n;
} *gc_work = NULL;
static size_t gc_nwork = 0, gc_capwork = 0;
static void gc_consider(uintptr_t x) {
  if (x < (uintptr_t)gc_heap || x >= (uintptr_t)gc_heap + (gc_top << GC_PAGE_SHIFT)) return;
  size_t off = x - (uintptr_t)gc_heap;
  size_t pi = off >> GC_PAGE_SHIFT;
  gc_page *g = &gc_pages[pi];
  uint8_t *p;
  size_t n;
  if (g->kind == 3) {
    pi -= g->n;
    g = &gc_pages[pi];
  }
  if (g->kind == 2) {
    if (g->mark[0] & 1) return;
    g->mark[0] |= 1;
    p = gc_heap + (pi << GC_PAGE_SHIFT);
    n = (size_t)g->n << GC_PAGE_SHIFT;
  } else if (g->kind == 1) {
    uint32_t size = gc_sizes[g->cls];
    uint32_t b = (uint32_t)((off & (GC_PAGE - 1)) / size);
    if (b >= g->n) return;
    uint64_t bit = (uint64_t)1 << (b & 63);
    if (!(g->used[b >> 6] & bit) || (g->mark[b >> 6] & bit)) return;
    g->mark[b >> 6] |= bit;
    p = gc_heap + (pi << GC_PAGE_SHIFT) + (size_t)b * size;
    n = size;
  } else
    return;
  if (gc_nwork == gc_capwork) {
    gc_capwork = gc_capwork == 0 ? 4096 : gc_capwork * 2;
    gc_work = realloc(gc_work, gc_capwork * sizeof *gc_work);
    if (gc_work == NULL) abort();
  }
  gc_work[gc_nwork].p = p;
  gc_work[gc_nwork++].n = n;
}
static void gc_scan(const void *lo, const void *hi) {
  uintptr_t a = ((uintptr_t)lo + sizeof(uintptr_t) - 1) & ~(uintptr_t)(sizeof(uintptr_t) - 1);
  for (const uintptr_t *w = (const uintptr_t *)a; (const void *)(w + 1) <= hi; w++) {
    uintptr_t x = *w;
#if UINTPTR_MAX > 0xFFFFFFFFu
    uint64_t top = (uint64_t)x >> 48;
    if (top >= 0xFFFA) x &= 0x0000FFFFFFFFFFFFull;
    else if (top != 0) continue;
#endif
    gc_consider(x);
  }
}
static void gc_drain(void) {
  while (gc_nwork > 0) {
    gc_nwork--;
    uint8_t *p = gc_work[gc_nwork].p;
    gc_scan(p, p + gc_work[gc_nwork].n);
  }
}
#ifdef YK_NOLIBC
static void gc_scan_segment(uint8_t *lo, uint8_t *hi) {
  gc_scan(lo, hi);
  gc_drain();
}
#else
static int gc_segment(struct dl_phdr_info *info, size_t size, void *data) {
  (void)size;
  (void)data;
  for (int i = 0; i < info->dlpi_phnum; i++) {
    const ElfW(Phdr) *ph = &info->dlpi_phdr[i];
    if (ph->p_type != PT_LOAD || !(ph->p_flags & PF_W)) continue;
    uint8_t *lo = (uint8_t *)(info->dlpi_addr + ph->p_vaddr);
    gc_scan(lo, lo + ph->p_memsz);
    gc_drain();
  }
  return 0;
}
#endif
static __attribute__((noinline)) void gc_mark_roots(void) {
  jmp_buf regs; /* the callee-saved registers, on this frame */
  setjmp(regs);
  gc_scan(&regs, (uint8_t *)&regs + sizeof regs);
  uintptr_t sp = (uintptr_t)__builtin_frame_address(0);
  uintptr_t from = gc_in_coroutine() ? gc_main_sp : sp;
  if (from != 0 && from < gc_stack_top) gc_scan((void *)from, (void *)gc_stack_top);
  gc_drain();
  /* On a coroutine's stack: its block is reached through current_coro (a writable global), but
     this frame's part of it is scanned here too, so registers spilled below it are seen. */
  if (gc_in_coroutine()) {
    uint8_t probe;
    gc_consider((uintptr_t)&probe);
    gc_drain();
  }
#ifdef YK_NOLIBC
  yk_writable_segments(gc_scan_segment);
#else
  dl_iterate_phdr(gc_segment, NULL);
#endif
  gc_drain();
}
static size_t gc_count = 0, gc_live_last = 0;
static void gc_report(void) {
  fprintf(stderr, "yk gc: %zu collections, %zu bytes live after the last, %zu pages in use\n",
          gc_count, gc_live_last, gc_top);
}
static void gc_collect(void) {
  gc_count++;
  gc_mark_roots();
  for (size_t c = 0; c < GC_NCLASS; c++) gc_free[c] = NULL;
  size_t live = 0;
  for (size_t pi = 0; pi < gc_top; pi++) {
    gc_page *g = &gc_pages[pi];
    if (g->kind == 2) {
      size_t k = g->n;
      if (g->mark[0] & 1) {
        g->mark[0] = 0;
        live += k << GC_PAGE_SHIFT;
      } else {
        g->used[0] = 0;
        gc_put_pages(pi, k);
      }
      pi += k - 1;
    } else if (g->kind == 1) {
      uint32_t size = gc_sizes[g->cls];
      int any = 0;
      for (int w = 0; w < 64; w++) {
        g->used[w] &= g->mark[w];
        g->mark[w] = 0;
        if (g->used[w]) any = 1;
      }
      if (!any) {
        gc_put_pages(pi, 1);
        continue;
      }
      uint8_t *base = gc_heap + (pi << GC_PAGE_SHIFT);
      for (uint32_t b = g->n; b-- > 0;) {
        if (g->used[b >> 6] & ((uint64_t)1 << (b & 63))) {
          live += size;
          continue;
        }
        *(void **)(base + (size_t)b * size) = gc_free[g->cls];
        gc_free[g->cls] = base + (size_t)b * size;
      }
    }
  }
  gc_since = 0;
  gc_live_last = live;
  gc_threshold = live > gc_floor ? live : gc_floor;
}
#else
static void *alloc(size_t n) { return bump(n); }
static uintptr_t gc_main_sp = 0;
#endif
/* Memory that is freed and holds no values (scratch buffers): the C library's. */
static void *scratch(size_t n) {
  void *p = calloc(1, n);
  if (p == NULL) abort();
  return p;
}
/* A heap block grown from `old` bytes to `n`: a new block with the old one's bytes. */
static void *grow(void *p, size_t old, size_t n) {
  void *q = alloc(n);
  if (p != NULL && old > 0) memcpy(q, p, old < n ? old : n);
  return q;
}

static yk_string *new_string(uint32_t len) {
  yk_string *s = alloc(sizeof(yk_string) + (size_t)len * 2);
  s->len = len;
  return s;
}

static yk string_of(yk_string *s) { return BOX(T_STRING, s); }

/* A string from UTF-8 bytes, as a source literal is written. */
yk yk_string_utf8(const char *p, uint64_t n) {
  uint16_t *tmp = scratch((size_t)n * 2 + 2);
  uint32_t len = 0;
  for (uint64_t i = 0; i < n;) {
    uint32_t c = (unsigned char)p[i];
    int extra = c < 0x80 ? 0 : c < 0xE0 ? 1 : c < 0xF0 ? 2 : 3;
    c &= extra == 0 ? 0x7F : extra == 1 ? 0x1F : extra == 2 ? 0x0F : 0x07;
    for (int k = 1; k <= extra && i + k < n; k++) c = (c << 6) | ((unsigned char)p[i + k] & 0x3F);
    i += extra + 1;
    if (c >= 0x10000) {
      c -= 0x10000;
      tmp[len++] = (uint16_t)(0xD800 + (c >> 10));
      tmp[len++] = (uint16_t)(0xDC00 + (c & 0x3FF));
    } else
      tmp[len++] = (uint16_t)c;
  }
  yk_string *s = new_string(len);
  memcpy(s->units, tmp, (size_t)len * 2);
  free(tmp);
  return string_of(s);
}

static yk ascii(const char *p) { return yk_string_utf8(p, strlen(p)); }

static yk_string *str(yk v) { return (yk_string *)PTR(v); }
static yk_array *arr(yk v) { return (yk_array *)PTR(v); }

/* --- arrays --- */

static yk_array *new_array(uint32_t cap) {
  yk_array *a = alloc(sizeof(yk_array));
  a->len = 0;
  a->cap = cap < 4 ? 4 : cap;
  a->items = alloc((size_t)a->cap * sizeof(yk));
  a->props = 0;
  a->holes = NULL;
  a->holes_n = 0;
  return a;
}
/* Holes (#1330): an index below the length the array does not have. Its item is undefined, so
   whatever reads items without asking sees undefined; HasProperty, the keys and the callback
   methods ask. */
static int array_hole(const yk_array *a, uint32_t i) {
  return a->holes != NULL && (i >> 3) < a->holes_n && ((a->holes[i >> 3] >> (i & 7)) & 1);
}
static void array_mark_hole(yk_array *a, uint32_t i, int on) {
  if ((i >> 3) >= a->holes_n) {
    if (!on) return;
    uint32_t n = (i >> 3) + 1;
    n = n < 8 ? 8 : n * 2;
    uint8_t *h = alloc(n);
    if (a->holes != NULL) memcpy(h, a->holes, a->holes_n);
    a->holes = h;
    a->holes_n = n;
  }
  if (on) a->holes[i >> 3] |= (uint8_t)(1u << (i & 7));
  else a->holes[i >> 3] &= (uint8_t)~(1u << (i & 7));
}
yk yk_array_hole(yk v, int64_t i) {
  array_mark_hole(arr(v), (uint32_t)i, 1);
  return v;
}

static void push(yk_array *a, yk v) {
  if (a->holes != NULL) array_mark_hole(a, a->len, 0);
  if (a->len == a->cap) {
    a->cap *= 2;
    yk *items = alloc((size_t)a->cap * sizeof(yk));
    memcpy(items, a->items, (size_t)a->len * sizeof(yk));
    a->items = items;
  }
  a->items[a->len++] = v;
}

/* An array literal of `n` elements. */
yk yk_array_of(uint64_t n, const yk *items) {
  yk_array *a = new_array((uint32_t)n);
  for (uint64_t i = 0; i < n; i++) push(a, items[i]);
  return BOX(T_ARRAY, a);
}

static yk call_value(yk f, yk self, uint64_t argc, const yk *argv);
static yk async_member(void *o, yk key);
static yk async_call(void *c, yk self, uint64_t argc, const yk *argv);
static yk generator_new(void *c, yk self, uint64_t argc, const yk *argv);
static yk agen_new(void *c, yk self, uint64_t argc, const yk *argv);
static int generator_step(yk gen, yk *out);
static void type_error(const char *what);
yk yk_object_of(uint64_t n, const yk *keys, const yk *values);
yk yk_closure_new(yk_code code, int32_t has_this, uint64_t n, const yk *captures);
static int own_get(yk_object *o, yk key, yk *out);
static int64_t own_find_chars(yk_object *o, const char *p, uint32_t n);
static int chain_get(yk obj, yk key, yk *out);
static yk number_format(double x, int which, yk arg);
static yk substring(yk_string *s, uint32_t a, uint32_t b);
static yk resolve_slot(yk slot, yk receiver);
static int array_callback_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int array_more_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int collection_method(yk_object *o, yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int same_value_zero(yk a, yk b);
static int string_pattern_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static int is_regexp(yk v);
static yk regexp_exec(yk re, yk s);
static yk_array *iterable_items(yk v);
/* A built-in method's thunk (an intrinsic prototype's): a method call that finds one along the
   receiver's own chain goes on to the runtime's own implementation (the thunk would only come back). */
static yk method_thunk_code(void *c, yk self, uint64_t argc, const yk *argv);
static yk object_thunk_code(void *c, yk self, uint64_t argc, const yk *argv);
static yk builtin_iter_new(yk src, int mode, int type);
static int is_builtin_iter(yk v);
static int builtin_iter_step(yk v, yk *out);
static yk iter_result(yk value, int done);
static int is_thunk(yk f) {
  if (TAG(f) != 0xFFFDu) return 0;
  yk_code code = ((yk_closure *)PTR(f))->code;
  return code == method_thunk_code || code == object_thunk_code;
}
static yk big_to_string_v(yk v);
static double big_to_double_v(yk v);
static int big_cmp_v(yk a, yk b);
static int big_cmp_double_v(yk a, double y);
static yk big_binary(yk a, yk b, char op);
static int numeric_pair(yk *a, yk *b);
static yk big_from_string_v(yk s);
static yk big_negate(yk a);
static yk big_add_small(yk a, int64_t k);
static uint32_t to_uint32(yk v);
static int32_t to_int32(yk v);
static int buffer_get(yk obj, yk key, yk *out);
static void range_error(const char *what);
static int program_mode;
yk yk_global(const char *name, uint64_t n);
static yk buffer_primitive(yk v);
static int buffer_set(yk obj, yk key, yk value);
static int buffer_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);

/* --- ToString --- */

static yk concat(yk_string *a, yk_string *b) {
  yk_string *s = new_string(a->len + b->len);
  memcpy(s->units, a->units, (size_t)a->len * 2);
  memcpy(s->units + a->len, b->units, (size_t)b->len * 2);
  return string_of(s);
}

/* Number::toString(10): the shortest digits that round-trip, laid out as ECMA-262 says. */
static yk number_to_string(double d) {
  if (d != d) return ascii("NaN");
  if (d == 0) return ascii("0");
  if (isinf(d)) return ascii(d < 0 ? "-Infinity" : "Infinity");
  /* An integer below 2^53 (an index, most often): its digits, which are the shortest. */
  if (d == (double)(int64_t)d && fabs(d) < 9007199254740992.0) {
    char t[24];
    int64_t v = (int64_t)d;
    uint64_t u = v < 0 ? (uint64_t)0 - (uint64_t)v : (uint64_t)v;
    int i = (int)sizeof t;
    t[--i] = 0;
    do {
      t[--i] = (char)('0' + u % 10);
      u /= 10;
    } while (u != 0);
    if (v < 0) t[--i] = '-';
    return ascii(t + i);
  }
  char buf[64], digits[32];
  int k = 0, n = 0;
  for (int p = 1; p <= 17; p++) {
    snprintf(buf, sizeof buf, "%.*e", p - 1, fabs(d));
    if (strtod(buf, NULL) == fabs(d)) break;
  }
  /* buf is d.ddde±x: the digits, and n = x + 1. */
  for (char *c = buf; *c != 'e'; c++)
    if (*c >= '0' && *c <= '9') digits[k++] = *c;
  while (k > 1 && digits[k - 1] == '0') k--;
  n = atoi(strchr(buf, 'e') + 1) + 1;
  char out[64];
  int o = 0;
  if (d < 0) out[o++] = '-';
  if (k <= n && n <= 21) {
    for (int i = 0; i < k; i++) out[o++] = digits[i];
    for (int i = k; i < n; i++) out[o++] = '0';
  } else if (0 < n && n <= 21) {
    for (int i = 0; i < n; i++) out[o++] = digits[i];
    out[o++] = '.';
    for (int i = n; i < k; i++) out[o++] = digits[i];
  } else if (-6 < n && n <= 0) {
    out[o++] = '0';
    out[o++] = '.';
    for (int i = 0; i < -n; i++) out[o++] = '0';
    for (int i = 0; i < k; i++) out[o++] = digits[i];
  } else {
    out[o++] = digits[0];
    if (k > 1) {
      out[o++] = '.';
      for (int i = 1; i < k; i++) out[o++] = digits[i];
    }
    o += snprintf(out + o, sizeof out - o, "e%c%d", n - 1 < 0 ? '-' : '+', abs(n - 1));
  }
  out[o] = 0;
  return ascii(out);
}

static yk to_string(yk v);

/*
 * Number::toString(radix) for a radix other than 10, as V8 writes it (DoubleToRadixCString): the
 * fraction's digits while they are above half a unit in the last place of the value (scaled with
 * them), rounded half to even with a carry back through the digits written; the integer's digits by
 * repeated division, those below the double's precision zeros.
 */
static yk number_to_radix(double value, int radix) {
  static const char chars[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (value != value) return ascii("NaN");
  if (isinf(value)) return ascii(value < 0 ? "-Infinity" : "Infinity");
  /* An integer below 2^53 (a byte's hex, most often): its digits by integer division. */
  if (value == (double)(int64_t)value && fabs(value) < 9007199254740992.0) {
    char t[72];
    int64_t v = (int64_t)value;
    uint64_t u = v < 0 ? (uint64_t)0 - (uint64_t)v : (uint64_t)v;
    int i = (int)sizeof t;
    t[--i] = 0;
    do {
      t[--i] = chars[u % (uint64_t)radix];
      u /= (uint64_t)radix;
    } while (u != 0);
    if (v < 0) t[--i] = '-';
    return ascii(t + i);
  }
  enum { kBufferSize = 2200 };
  char buffer[kBufferSize];
  int integer_cursor = kBufferSize / 2;
  int fraction_cursor = integer_cursor;
  int negative = value < 0;
  if (negative) value = -value;
  double integer = floor(value);
  double fraction = value - integer;
  double delta = 0.5 * (nextafter(value, INFINITY) - value);
  double min_delta = nextafter(0.0, 1.0);
  if (delta < min_delta) delta = min_delta;
  if (fraction >= delta) {
    buffer[fraction_cursor++] = '.';
    do {
      fraction *= radix;
      delta *= radix;
      int digit = (int)fraction;
      buffer[fraction_cursor++] = chars[digit];
      fraction -= digit;
      if (fraction > 0.5 || (fraction == 0.5 && (digit & 1))) {
        if (fraction + delta > 1) {
          for (;;) {
            fraction_cursor--;
            if (fraction_cursor == kBufferSize / 2) {
              integer += 1;
              break;
            }
            char c = buffer[fraction_cursor];
            int d = c > '9' ? (c - 'a' + 10) : (c - '0');
            if (d + 1 < radix) {
              buffer[fraction_cursor++] = chars[d + 1];
              break;
            }
          }
          break;
        }
      }
    } while (fraction >= delta);
  }
  while (integer / radix >= 9007199254740992.0) {
    integer /= radix;
    buffer[--integer_cursor] = '0';
  }
  do {
    double remainder = fmod(integer, radix);
    buffer[--integer_cursor] = chars[(int)remainder];
    integer = (integer - remainder) / radix;
  } while (integer > 0);
  if (negative) buffer[--integer_cursor] = '-';
  buffer[fraction_cursor] = 0;
  return ascii(buffer + integer_cursor);
}

static yk array_join(yk_array *a, yk_string *sep) {
  /* Its length when the join starts; each element's ToString in order (undefined and null: ""),
     then one string of them (each kept in a block the collector sees). */
  uint32_t len = a->len;
  if (len == 0) return ascii("");
  if (len == 1) return a->len > 0 && !is_nullish(a->items[0]) ? to_string(a->items[0]) : ascii("");
  yk *parts = alloc((size_t)len * sizeof(yk));
  uint64_t total = (uint64_t)sep->len * (len - 1);
  for (uint32_t i = 0; i < len; i++) {
    yk v = i < a->len ? a->items[i] : YK_UNDEFINED;
    parts[i] = is_nullish(v) ? 0 : to_string(v);
    if (parts[i] != 0) total += str(parts[i])->len;
  }
  if (total > 536870888) range_error("Invalid string length");
  yk_string *r = new_string((uint32_t)total);
  uint64_t at = 0;
  for (uint32_t i = 0; i < len; i++) {
    if (i > 0) {
      memcpy(r->units + at, sep->units, (size_t)sep->len * 2);
      at += sep->len;
    }
    if (parts[i] != 0) {
      yk_string *t = str(parts[i]);
      memcpy(r->units + at, t->units, (size_t)t->len * 2);
      at += t->len;
    }
  }
  return string_of(r);
}

static yk to_primitive(yk v);

/* --- symbols (ECMA-262 20.4): an internal value (kind 4) with its description; equal only to itself.
   The well-known ones are made once. A symbol is a property key as it is; ToString of one throws. */
typedef struct {
  int32_t internal; /* 4 */
  int32_t registered;
  yk description; /* a string, or undefined */
} yk_symbol;
static int is_symbol(yk v) { return TAG(v) == T_INTERNAL && *(int32_t *)PTR(v) == 4; }
static yk symbol_new(yk description) {
  yk_symbol *y = alloc(sizeof(yk_symbol));
  y->internal = 4;
  y->description = description;
  return BOX(T_INTERNAL, y);
}
static const char *const well_known_names[] = {"asyncIterator", "hasInstance", "isConcatSpreadable", "iterator",
                                               "match", "matchAll", "replace", "search", "species", "split",
                                               "toPrimitive", "toStringTag", "unscopables", "dispose", "asyncDispose"};
#define N_WELL_KNOWN 15
static yk well_known[N_WELL_KNOWN];
static yk well_known_symbol(int i) {
  if (well_known[i] == 0) {
    char desc[40];
    snprintf(desc, sizeof desc, "Symbol.%s", well_known_names[i]);
    well_known[i] = symbol_new(ascii(desc));
  }
  return well_known[i];
}
static yk symbol_iterator(void) { return well_known_symbol(3); }
static yk symbol_async_iterator(void) { return well_known_symbol(0); }
static int string_equal(yk_string *a, yk_string *b);
static int symbol_member(yk sym, yk key, yk *out);
static yk make_error(const char *name, yk message);
_Noreturn void yk_throw(yk v);
static yk proto_lookup(yk v, yk key);
static yk tail_proto(yk v);
static int has_own(yk v, yk key);
static void set_hidden(yk_object *o, yk key, int hidden);
static int is_hidden(yk_object *o, yk key);
static yk object_to_string(yk v);
static yk method_thunk_code(void *c, yk self, uint64_t argc, const yk *argv);
static yk object_thunk_code(void *c, yk self, uint64_t argc, const yk *argv);
static yk named(yk f, yk name);
static void name_method(yk f, yk key, const char *prefix);
static yk case_convert(yk v, int upper);
static int date_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out);
static yk date_string(double t, int what);
/* Property keys equal: the same symbol, or strings of the same units. */
static int key_equal(yk a, yk b) {
  if (a == b) return 1;
  return is_string(a) && is_string(b) && string_equal(str(a), str(b));
}
/* ToPropertyKey: a symbol as it is; anything else its string. */
static yk to_property_key(yk v) {
  if (is_object(v) || is_closure(v)) v = to_primitive(v);
  return is_symbol(v) ? v : to_string(v);
}
/* SymbolDescriptiveString: Symbol(description). */
static yk symbol_descriptive(yk v) {
  yk d = ((yk_symbol *)PTR(v))->description;
  return concat(str(concat(str(ascii("Symbol(")), str(d == YK_UNDEFINED ? ascii("") : d))), str(ascii(")")));
}

static yk to_string(yk v) {
  if (is_object(v) || is_closure(v)) return to_string(to_primitive(v));
  if (is_string(v)) return v;
  if (is_symbol(v)) type_error("Cannot convert a Symbol value to a string");
  if (is_number(v)) return number_to_string(num(v));
  if (v == YK_UNDEFINED) return ascii("undefined");
  if (v == YK_NULL) return ascii("null");
  if (v == YK_TRUE) return ascii("true");
  if (v == YK_FALSE) return ascii("false");
  if (is_bigint(v)) return big_to_string_v(v);
  return array_join(arr(v), str(ascii(",")));
}

/*
 * ToPrimitive (hint default): an array is its join; an object calls its own valueOf, then its own
 * toString, as Object.prototype's would be overridden, else "[object Object]"; a function has no
 * source text here, so it is a fixed string.
 */
static yk to_primitive(yk v) {
  if (is_array(v)) return to_string(v);
  if (is_closure(v)) return ascii("function () { [native code] }");
  if (!is_object(v)) return v;
  yk_object *self = (yk_object *)PTR(v);
  if (self->kind != 0 && is_object(self->proto)) {
    /* A subclass's (or the program's) own valueOf / toString first (a Buffer's toString). */
    static const char *own_names[2] = {"valueOf", "toString"};
    for (int i = 0; i < 2; i++) {
      yk f;
      if (chain_get(v, ascii(own_names[i]), &f) && is_closure(f = resolve_slot(f, v)) && !is_thunk(f)) {
        yk r = call_value(f, v, 0, NULL);
        if (!is_reference(r)) return r;
      }
    }
  }
  /* A typed array's toString is its join; a buffer's and a view's, their tag. */
  if (self->kind == 7) return buffer_primitive(v);
  if (self->kind == 6) return ascii("[object ArrayBuffer]");
  if (self->kind == 10) return date_string(*(double *)self->ext, 0); /* a Date's default hint is string */
  if (self->kind == 8) return ascii("[object DataView]");
  if (self->kind == 3)
    return concat(str(concat(str(concat(str(ascii("/")), str(self->regex[0]))), str(ascii("/")))), str(self->regex[1]));
  static const char *names[2] = {"valueOf", "toString"};
  for (int i = 0; i < 2; i++) {
    yk f;
    if (chain_get(v, ascii(names[i]), &f) && is_closure(f = resolve_slot(f, v))) {
      yk r = call_value(f, v, 0, NULL);
      if (!is_reference(r)) return r;
    }
  }
  if (self->error) {
    /* Error.prototype.toString: name, ": ", message (either alone when the other is empty). */
    yk name, message;
    yk n = own_get(self, ascii("name"), &name) ? to_string(name) : ascii("Error");
    yk msg = own_get(self, ascii("message"), &message) ? to_string(message) : ascii("");
    if (str(msg)->len == 0) return n;
    if (str(n)->len == 0) return msg;
    return concat(str(concat(str(n), str(ascii(": ")))), str(msg));
  }
  return ascii("[object Object]");
}

/* --- ToNumber --- */

static int is_space(uint16_t c) {
  return c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 0xA0 ||
         c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 ||
         c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
}

static double string_to_number(yk_string *s) {
  uint32_t a = 0, b = s->len;
  while (a < b && is_space(s->units[a])) a++;
  while (b > a && is_space(s->units[b - 1])) b--;
  if (a == b) return 0;
  char buf[400];
  if (b - a >= sizeof buf) return NAN;
  for (uint32_t i = a; i < b; i++) {
    if (s->units[i] > 0x7F) return NAN;
    buf[i - a] = (char)s->units[i];
  }
  buf[b - a] = 0;
  /* 0x, 0o, 0b: an unsigned integer in that radix. */
  if (buf[0] == '0' && (buf[1] == 'x' || buf[1] == 'X' || buf[1] == 'o' || buf[1] == 'O' ||
                        buf[1] == 'b' || buf[1] == 'B')) {
    int radix = buf[1] == 'x' || buf[1] == 'X' ? 16 : buf[1] == 'o' || buf[1] == 'O' ? 8 : 2;
    if (buf[2] == 0) return NAN;
    double r = 0;
    for (char *c = buf + 2; *c; c++) {
      int dgt = *c >= '0' && *c <= '9'   ? *c - '0'
                : *c >= 'a' && *c <= 'f' ? *c - 'a' + 10
                : *c >= 'A' && *c <= 'F' ? *c - 'A' + 10
                                         : 99;
      if (dgt >= radix) return NAN;
      r = r * radix + dgt;
    }
    return r;
  }
  const char *p = buf;
  int neg = 0;
  if (*p == '+' || *p == '-') neg = *p++ == '-';
  if (strcmp(p, "Infinity") == 0) return neg ? -INFINITY : INFINITY;
  /* StrUnsignedDecimalLiteral: digits [. digits] [e[+-]digits], at least one digit before e. */
  const char *q = p;
  int digits = 0;
  while (*q >= '0' && *q <= '9') q++, digits++;
  if (*q == '.') {
    q++;
    while (*q >= '0' && *q <= '9') q++, digits++;
  }
  if (digits == 0) return NAN;
  if (*q == 'e' || *q == 'E') {
    q++;
    if (*q == '+' || *q == '-') q++;
    if (!(*q >= '0' && *q <= '9')) return NAN;
    while (*q >= '0' && *q <= '9') q++;
  }
  if (*q != 0) return NAN;
  return strtod(buf, NULL);
}

static double to_number(yk v) {
  if (is_number(v)) return num(v);
  if (v == YK_UNDEFINED) return NAN;
  if (v == YK_NULL || v == YK_FALSE) return 0;
  if (v == YK_TRUE) return 1;
  if (is_string(v)) return string_to_number(str(v));
  if (is_bigint(v)) type_error("Cannot convert a BigInt value to a number");
  v = to_primitive(v);
  if (is_bigint(v)) type_error("Cannot convert a BigInt value to a number");
  return to_number(v);
}

/* --- operators --- */

int yk_truthy(yk v) {
  if (is_number(v)) {
    double d = num(v);
    return d == d && d != 0;
  }
  if (is_string(v)) return str(v)->len > 0;
  if (is_reference(v)) return 1;
  if (is_bigint(v)) return ((yk_bigint *)PTR(v))->len != 0;
  return v == YK_TRUE;
}

yk yk_add(yk a, yk b) {
  if (is_number(a) && is_number(b)) return yk_number(num(a) + num(b));
  if (is_string(a) && is_string(b)) {
    /* Two strings: one of them alone when the other is empty, else their concatenation. */
    if (str(b)->len == 0) return a;
    if (str(a)->len == 0) return b;
    if ((uint64_t)str(a)->len + str(b)->len > 536870888) range_error("Invalid string length");
    return concat(str(a), str(b));
  }
  a = to_primitive(a);
  b = to_primitive(b);
  if (is_string(a) || is_string(b)) return concat(str(to_string(a)), str(to_string(b)));
  if (numeric_pair(&a, &b)) return big_binary(a, b, '+');
  return yk_number(to_number(a) + to_number(b));
}
yk yk_sub(yk a, yk b) {
  if (is_number(a) && is_number(b)) return yk_number(num(a) - num(b));
  return numeric_pair(&a, &b) ? big_binary(a, b, '-') : yk_number(to_number(a) - to_number(b));
}
yk yk_mul(yk a, yk b) {
  if (is_number(a) && is_number(b)) return yk_number(num(a) * num(b));
  return numeric_pair(&a, &b) ? big_binary(a, b, '*') : yk_number(to_number(a) * to_number(b));
}
yk yk_div(yk a, yk b) {
  if (is_number(a) && is_number(b)) return yk_number(num(a) / num(b));
  return numeric_pair(&a, &b) ? big_binary(a, b, '/') : yk_number(to_number(a) / to_number(b));
}
yk yk_mod(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '%') : yk_number(fmod(to_number(a), to_number(b))); }
yk yk_neg(yk a) {
  a = to_primitive(a);
  return is_bigint(a) ? big_negate(a) : yk_number(-to_number(a));
}
yk yk_pos(yk a) { return yk_number(to_number(a)); }
yk yk_not(yk a) { return yk_bool(!yk_truthy(a)); }
yk yk_inc(yk a) {
  if (is_number(a)) return yk_number(num(a) + 1);
  a = to_primitive(a);
  return is_bigint(a) ? big_add_small(a, 1) : yk_number(to_number(a) + 1);
}
yk yk_dec(yk a) {
  if (is_number(a)) return yk_number(num(a) - 1);
  a = to_primitive(a);
  return is_bigint(a) ? big_add_small(a, -1) : yk_number(to_number(a) - 1);
}
int yk_is_nullish(yk a) { return is_nullish(a); }

static int string_equal(yk_string *a, yk_string *b) {
  return a->len == b->len && memcmp(a->units, b->units, (size_t)a->len * 2) == 0;
}

static int strict_equal(yk a, yk b) {
  if (is_number(a) && is_number(b)) return num(a) == num(b);
  if (is_string(a) && is_string(b)) return string_equal(str(a), str(b));
  if (is_bigint(a) && is_bigint(b)) return big_cmp_v(a, b) == 0;
  return a == b;
}
yk yk_seq(yk a, yk b) { return yk_bool(strict_equal(a, b)); }
yk yk_sne(yk a, yk b) { return yk_bool(!strict_equal(a, b)); }

static int loose_equal(yk a, yk b) {
  /* null and undefined share a tag, and are loosely equal to each other only. */
  if (is_nullish(a) || is_nullish(b)) return is_nullish(a) && is_nullish(b);
  if (TAG(a) == TAG(b) || (is_number(a) && is_number(b))) return strict_equal(a, b);
  if (is_bool(a)) return loose_equal(yk_number(to_number(a)), b);
  if (is_bool(b)) return loose_equal(a, yk_number(to_number(b)));
  if (is_reference(a) && !is_reference(b)) return loose_equal(to_primitive(a), b);
  if (is_reference(b) && !is_reference(a)) return loose_equal(a, to_primitive(b));
  if (is_number(a) && is_string(b)) return num(a) == to_number(b);
  if (is_string(a) && is_number(b)) return to_number(a) == num(b);
  if (is_bigint(a) && is_number(b)) return big_cmp_double_v(a, num(b)) == 0;
  if (is_number(a) && is_bigint(b)) return big_cmp_double_v(b, num(a)) == 0;
  if (is_bigint(a) && is_string(b)) {
    yk n = big_from_string_v(b);
    return n != 0 && big_cmp_v(a, n) == 0;
  }
  if (is_string(a) && is_bigint(b)) return loose_equal(b, a);
  return 0;
}
yk yk_eq(yk a, yk b) { return yk_bool(loose_equal(a, b)); }
yk yk_ne(yk a, yk b) { return yk_bool(!loose_equal(a, b)); }

/* IsLessThan: -1 for undefined (a NaN took part), else 0 or 1. */
static int less_than(yk a, yk b) {
  if (is_number(a) && is_number(b)) {
    double x = num(a), y = num(b);
    return x != x || y != y ? -1 : x < y;
  }
  a = to_primitive(a);
  b = to_primitive(b);
  if (is_string(a) && is_string(b)) {
    yk_string *x = str(a), *y = str(b);
    uint32_t n = x->len < y->len ? x->len : y->len;
    for (uint32_t i = 0; i < n; i++)
      if (x->units[i] != y->units[i]) return x->units[i] < y->units[i];
    return x->len < y->len;
  }
  if (is_bigint(a) || is_bigint(b)) {
    if (is_string(a) && (a = big_from_string_v(a)) == 0) return -1;
    if (is_string(b) && (b = big_from_string_v(b)) == 0) return -1;
    if (is_bigint(a) && is_bigint(b)) return big_cmp_v(a, b) < 0;
    if (is_bigint(a)) {
      int c = big_cmp_double_v(a, to_number(b));
      return c == 2 ? -1 : c < 0;
    }
    int c = big_cmp_double_v(b, to_number(a));
    return c == 2 ? -1 : c > 0;
  }
  double x = to_number(a), y = to_number(b);
  if (x != x || y != y) return -1;
  return x < y;
}
yk yk_lt(yk a, yk b) { return yk_bool(less_than(a, b) == 1); }
yk yk_gt(yk a, yk b) { return yk_bool(less_than(b, a) == 1); }
yk yk_le(yk a, yk b) { return yk_bool(less_than(b, a) == 0); }
yk yk_ge(yk a, yk b) { return yk_bool(less_than(a, b) == 0); }

static yk interned(const char *name, uint64_t n);
/* A string builder (#1369): a loop's variable that the loop only appends to (`out += x`), its value
   kept here while the loop runs. Until the value is a string, an append is +'s (a number's sum, say);
   from then on a string's units, appended in place (each append ToPrimitive then ToString of the
   operand, as + is). The loop's result is yk_sb_finish's. */
typedef struct {
  int32_t internal; /* 5: a string builder */
  uint32_t len, cap;
  yk value;          /* while not yet a string: the value */
  yk_string *buffer; /* once a string: its units (cap of them) */
} yk_sb;
yk yk_sb_new(yk value) {
  yk_sb *b = alloc(sizeof(yk_sb));
  b->internal = 5;
  b->value = value;
  return BOX(T_INTERNAL, b);
}
static void sb_reserve(yk_sb *b, uint64_t need) {
  if (need > 536870888) range_error("Invalid string length");
  if (b->buffer != NULL && need <= b->cap) return;
  uint64_t cap = b->cap < 16 ? 16 : b->cap;
  while (cap < need) cap *= 2;
  if (cap > 536870888) cap = 536870888;
  yk_string *n = new_string((uint32_t)cap);
  if (b->buffer != NULL) memcpy(n->units, b->buffer->units, (size_t)b->len * 2);
  b->buffer = n;
  b->cap = (uint32_t)cap;
}
yk yk_sb_append(yk h, yk x) {
  yk_sb *b = (yk_sb *)PTR(h);
  if (b->buffer == NULL) {
    if (!is_string(b->value)) {
      b->value = yk_add(b->value, x);
      return h;
    }
    yk_string *v = str(b->value);
    sb_reserve(b, (uint64_t)v->len * 2);
    memcpy(b->buffer->units, v->units, (size_t)v->len * 2);
    b->len = v->len;
    b->value = YK_UNDEFINED;
  }
  yk_string *t = str(is_string(x) ? x : to_string(to_primitive(x)));
  sb_reserve(b, (uint64_t)b->len + t->len);
  memcpy(b->buffer->units + b->len, t->units, (size_t)t->len * 2);
  b->len += t->len;
  return h;
}
yk yk_sb_finish(yk h) {
  yk_sb *b = (yk_sb *)PTR(h);
  if (b->buffer == NULL) return b->value;
  yk_string *r = new_string(b->len);
  memcpy(r->units, b->buffer->units, (size_t)b->len * 2);
  return string_of(r);
}

/* typeof's result: one string per type, made once. */
yk yk_typeof(yk v) {
  static yk made[8]; /* each made once (the collector sees this table) */
#define YK_TYPE(k, s) (made[k] != 0 ? made[k] : (made[k] = interned(s, sizeof s - 1)))
  if (is_number(v)) return YK_TYPE(0, "number");
  if (is_string(v)) return YK_TYPE(1, "string");
  if (is_bool(v)) return YK_TYPE(2, "boolean");
  if (v == YK_UNDEFINED) return YK_TYPE(3, "undefined");
  if (is_closure(v)) return YK_TYPE(4, "function");
  if (is_bigint(v)) return YK_TYPE(5, "bigint");
  if (is_symbol(v)) return YK_TYPE(6, "symbol");
  return YK_TYPE(7, "object");
#undef YK_TYPE
}

/* A template literal: its strings (n + 1) around its substitutions (n), each by ToString. */
yk yk_template(uint64_t n, const yk *strings, const yk *subs) {
  if (n == 0) return strings[0];
  /* Each substitution's string (in order: a ToString may throw or run code), then one string of
     them all. The strings are kept on this stack or in a block the collector sees. */
  yk small[8];
  yk *parts = n <= 8 ? small : alloc((size_t)n * sizeof(yk));
  uint64_t total = str(strings[0])->len;
  for (uint64_t i = 0; i < n; i++) {
    parts[i] = to_string(subs[i]);
    total += str(parts[i])->len + str(strings[i + 1])->len;
  }
  if (total > 536870888) range_error("Invalid string length");
  yk_string *r = new_string((uint32_t)total);
  uint64_t at = 0;
  for (uint64_t i = 0; i <= n; i++) {
    yk_string *a = str(strings[i]);
    memcpy(r->units + at, a->units, (size_t)a->len * 2);
    at += a->len;
    if (i < n) {
      yk_string *b = str(parts[i]);
      memcpy(r->units + at, b->units, (size_t)b->len * 2);
      at += b->len;
    }
  }
  return string_of(r);
}

/* --- properties --- */

/* An array index: a key that is a number (or numeric string) naming 0 .. 2^32 - 2. */
static int64_t index_of_key(yk key) {
  double d;
  if (is_number(key))
    d = num(key);
  else if (is_string(key)) {
    yk_string *s = str(key);
    if (s->len == 0 || s->len > 10) return -1;
    if (s->len > 1 && s->units[0] == '0') return -1;
    d = 0;
    for (uint32_t i = 0; i < s->len; i++) {
      if (s->units[i] < '0' || s->units[i] > '9') return -1;
      d = d * 10 + (s->units[i] - '0');
    }
  } else
    return -1;
  if (d < 0 || d > 4294967294.0 || d != floor(d)) return -1;
  return (int64_t)d;
}

/* Inlined at each use: the name is a literal, its length a constant, so most keys fail at once. */
static inline __attribute__((always_inline)) int key_is(yk key, const char *name) {
  if (!is_string(key)) return 0;
  yk_string *s = str(key);
  size_t n = __builtin_strlen(name);
  if (s->len != n) return 0;
  for (size_t i = 0; i < n; i++)
    if (s->units[i] != (unsigned char)name[i]) return 0;
  return 1;
}

static inline __attribute__((always_inline)) int typed_fast_get(yk obj, uint32_t i, yk *out);
static __attribute__((noinline)) yk yk_get_slow(yk obj, yk key);
static int64_t own_find_chars(yk_object *o, const char *p, uint32_t n);
static yk resolve_slot(yk slot, yk receiver);
/* A key added to an object: whether it starts with a digit (an index's may), and which index below 128
   it is. */
static void note_digit_key(yk_object *o, yk key) {
  if (!is_string(key)) return;
  yk_string *s = str(key);
  if (s->len == 0 || s->units[0] < '0' || s->units[0] > '9') return;
  uint32_t v = 0;
  int index = s->len <= 3 && (s->len == 1 || s->units[0] != '0');
  for (uint32_t i = 0; i < s->len && index; i++) {
    if (s->units[i] < '0' || s->units[i] > '9') index = 0;
    else v = v * 10 + (s->units[i] - '0');
  }
  if (index && v < 128) {
    o->small_ints[v >> 6] |= (uint64_t)1 << (v & 63);
    o->digit_keys |= 1;
  } else
    o->digit_keys |= 3;
}
/* Whether an object may have a key for index i (a key starting with a digit, and i's if below 128). */
static int digit_key_maybe(const yk_object *o, uint64_t i) {
  if (o->digit_keys == 0) return 0;
  if (o->digit_keys & 2) return 1;
  return i < 128 && ((o->small_ints[i >> 6] >> (i & 63)) & 1);
}
/* An index read of a plain object (a table by code point): by the index's digits along a chain of
   plain objects, no string made; a miss there is undefined (no built-in has such a name). 0 when
   the chain is not all plain objects. */
static int object_index_get(yk obj, uint32_t i, yk *out) {
  char t[12];
  int at = (int)sizeof t; /* the index's digits, made when an object may have them */
  yk v = obj;
  for (; v != 0 && is_object(v); v = ((yk_object *)PTR(v))->proto) {
    yk_object *c = (yk_object *)PTR(v);
    if (c->kind != 0) return 0;
    if (!digit_key_maybe(c, i)) continue;
    if (at == (int)sizeof t) {
      uint32_t u = i;
      do {
        t[--at] = (char)('0' + u % 10);
        u /= 10;
      } while (u != 0);
    }
    int64_t k = own_find_chars(c, t + at, (uint32_t)(sizeof t - at));
    if (k >= 0) return *out = resolve_slot(c->values[k], obj), 1;
  }
  if (v != 0) return 0;
  *out = YK_UNDEFINED;
  return 1;
}
/* One code unit's string: below 256, the one string of it (made once; the collector keeps the table). */
yk yk_units[256]; /* the lowering reads it too (emit-llvm-boxed.ts's indexRead) */
static yk unit_string(uint16_t u) {
  yk *units = yk_units;
  if (u < 256 && units[u] != 0) return units[u];
  yk_string *c = new_string(1);
  c->units[0] = u;
  yk r = string_of(c);
  if (u < 256) units[u] = r;
  return r;
}
static yk interned(const char *name, uint64_t n);
/* The one string "length" (the lowered code's reads of .length use it too). */
static yk length_key(void) {
  static yk k;
  return k != 0 ? k : (k = interned("length", 6));
}
/* A property read: its common cases here (a small function, no frame to set up), the rest in
   yk_get_slow. */
yk yk_get(yk obj, yk key) {
  if (is_number(key)) {
    double d = num(key);
    if (d >= 0 && d < 4294967295.0 && d == (double)(uint32_t)d) {
      uint32_t i = (uint32_t)d;
      if (is_array(obj)) {
        yk_array *a = arr(obj);
        if (i < a->len && (a->holes == NULL || !array_hole(a, i))) return a->items[i];
      } else if (is_object(obj) && ((yk_object *)PTR(obj))->kind == 0) {
        yk r;
        if (object_index_get(obj, i, &r)) return r;
      } else if (is_string(obj)) {
        if (i < str(obj)->len) return unit_string(str(obj)->units[i]);
      } else if (is_object(obj) && ((yk_object *)PTR(obj))->kind == 7) {
        yk r;
        if (typed_fast_get(obj, i, &r)) return r;
      }
    }
  } else if (is_object(obj)) {
    yk_object *o = (yk_object *)PTR(obj);
    if (o->kind == 0) {
      uint32_t n = o->len < 32 ? o->len : 32; /* names are made once: the key itself, by pointer */
      for (uint32_t i = 0; i < n; i++)
        if (o->keys[i] == key) {
          yk v = o->values[i];
          /* A data property's value as it is; an accessor (an internal box) through resolve_slot. */
          if (TAG(v) != T_INTERNAL) return v;
          return resolve_slot(v, obj);
        }
    }
  } else if (is_string(obj) && is_string(key) && key == length_key()) {
    return yk_number(str(obj)->len);
  }
  return yk_get_slow(obj, key);
}
static __attribute__((noinline)) yk yk_get_slow(yk obj, yk key) {
  /* An element by an integer index: an array's (not a hole), a typed array's, in range. */
  if (is_number(key)) {
    double d = num(key);
    if (d >= 0 && d < 4294967295.0 && d == (double)(uint32_t)d) {
      uint32_t i = (uint32_t)d;
      if (is_array(obj)) {
        yk_array *a = arr(obj);
        if (i < a->len && !array_hole(a, i)) return a->items[i];
      } else if (is_object(obj) && ((yk_object *)PTR(obj))->kind == 7) {
        yk r;
        if (typed_fast_get(obj, i, &r)) return r;
      }
    }
  }
  /* A plain object's own property by the very key (names are made once, so a read by name finds the
     key the object was made with): its value, before anything else is asked. */
  if (is_object(obj)) {
    yk_object *o = (yk_object *)PTR(obj);
    if (o->kind == 0) {
      uint32_t n = o->len < 8 ? o->len : 8;
      for (uint32_t i = 0; i < n; i++)
        if (o->keys[i] == key) return resolve_slot(o->values[i], obj);
    }
  }
  if (is_nullish(obj)) {
    /* V8's message: the property read, by its key. */
    yk k = is_symbol(key) ? symbol_descriptive(key) : to_string(key);
    yk m = concat(str(ascii(obj == YK_NULL ? "Cannot read properties of null (reading '" : "Cannot read properties of undefined (reading '")), str(k));
    yk_throw(make_error("TypeError", concat(str(m), str(ascii("')")))));
  }
  if (is_string(obj)) {
    yk_string *s = str(obj);
    if (key_is(key, "length")) return yk_number(s->len);
    int64_t i = index_of_key(key);
    if (i >= 0 && i < s->len) return unit_string(s->units[i]);
    return i >= 0 ? YK_UNDEFINED : proto_lookup(obj, key);
  }
  if (is_array(obj)) {
    yk_array *a = arr(obj);
    if (key_is(key, "length")) return yk_number(a->len);
    int64_t i = index_of_key(key);
    if (i >= 0 && i < a->len) return a->items[i];
    yk v;
    if (i < 0 && a->props != 0 && own_get((yk_object *)PTR(a->props), to_property_key(key), &v)) return v;
    return i >= 0 ? YK_UNDEFINED : proto_lookup(obj, key);
  }
  if (is_object(obj) && ((yk_object *)PTR(obj))->kind == 3) {
    yk_object *o = (yk_object *)PTR(obj);
    yk flags = o->regex[1];
    const char *names[8] = {"global", "ignoreCase", "multiline", "dotAll", "unicode", "sticky", "hasIndices", NULL};
    const char letters[8] = "gimsuyd";
    if (key_is(key, "source")) return o->regex[0];
    if (key_is(key, "flags")) return flags;
    for (int f = 0; names[f] != NULL; f++)
      if (key_is(key, names[f])) {
        for (uint32_t i = 0; i < str(flags)->len; i++)
          if (str(flags)->units[i] == (uint16_t)letters[f]) return YK_TRUE;
        return YK_FALSE;
      }
  }
  if (is_object(obj)) {
    yk_object *o = (yk_object *)PTR(obj);
    if (o->kind >= 6 && o->kind <= 8) {
      yk got;
      if (buffer_get(obj, key, &got)) return got;
    }
    if ((o->kind == 1 || o->kind == 2) && key_is(key, "size")) return yk_number(o->entries->len);
    if (o->kind == 4 || o->kind == 5 || o->kind == 9) {
      yk m = async_member(o, key);
      if (m != 0) return m;
    }
    if (is_number(key)) {
      /* An integer key (a table indexed by code points, say): found by its digits, with no string
         made; along a chain of plain objects, a miss is undefined (no built-in has such a name). */
      double d = to_number(key);
      if (d >= 0 && d < 1e15 && d == (double)(int64_t)d) {
        char t[20];
        int i = (int)sizeof t;
        uint64_t u = (uint64_t)d;
        do {
          t[--i] = (char)('0' + u % 10);
          u /= 10;
        } while (u != 0);
        yk v = obj;
        for (; v != 0 && is_object(v); v = ((yk_object *)PTR(v))->proto) {
          yk_object *c = (yk_object *)PTR(v);
          if (c->kind != 0) break;
          if (!digit_key_maybe(c, (uint64_t)d)) continue; /* no key of it can be this index's */
          int64_t at = own_find_chars(c, t + i, (uint32_t)(sizeof t - i));
          if (at >= 0) return resolve_slot(c->values[at], obj);
        }
        if (v == 0) return YK_UNDEFINED;
      }
    }
    yk v;
    return chain_get(obj, to_property_key(key), &v) ? resolve_slot(v, obj) : proto_lookup(obj, key);
  }
  if (is_closure(obj)) {
    yk v;
    return chain_get(obj, to_property_key(key), &v) ? resolve_slot(v, obj) : proto_lookup(obj, key);
  }
  if (is_symbol(obj)) {
    yk v;
    if (symbol_member(obj, key, &v)) return v;
  }
  return proto_lookup(obj, key);
}

/* A name the lowered code passes as its bytes (a constant at each site): its string, one per
   distinct text (so a key read and the key written are the same string, and compare at once). The
   table is by the bytes' content; an entry keeps a copy of them. The strings are reached from this
   table, so the collector keeps them. */
#define INTERN_SLOTS 16384
static struct {
  char *bytes;
  uint64_t n;
  yk value;
} intern_table[INTERN_SLOTS];
static yk interned(const char *name, uint64_t n) {
  if (n > 64) return yk_string_utf8(name, n);
  uint64_t h = 1469598103934665603ull ^ n;
  for (uint64_t i = 0; i < n; i++) h = (h ^ (uint8_t)name[i]) * 1099511628211ull;
  for (unsigned probe = 0; probe < 16; probe++) {
    unsigned i = (unsigned)((h >> 40) + probe) & (INTERN_SLOTS - 1);
    if (intern_table[i].bytes == NULL) {
      char *copy = malloc(n + 1);
      if (copy == NULL) return yk_string_utf8(name, n);
      memcpy(copy, name, n);
      intern_table[i].n = n;
      intern_table[i].value = yk_string_utf8(name, n);
      intern_table[i].bytes = copy;
      return intern_table[i].value;
    }
    if (intern_table[i].n == n && memcmp(intern_table[i].bytes, name, n) == 0) return intern_table[i].value;
  }
  return yk_string_utf8(name, n);
}
yk yk_get_named(yk obj, const char *name, uint64_t n) { return yk_get(obj, interned(name, n)); }
/* A name or literal the lowered code keeps in a global (its slot): the string, made at first use. */
yk yk_key_of(yk *slot, const char *p, uint64_t n) {
  if (*slot != 0) return *slot;
  return *slot = interned(p, n);
}
/* A string literal of the lowered code: its constant bytes' string, made once. */
yk yk_string_const(const char *p, uint64_t n) { return interned(p, n); }

/* ToIntegerOrInfinity, then clamped as slice / indexOf clamp a relative index. */
static int64_t relative(yk v, int64_t len, int64_t dflt) {
  if (v == YK_UNDEFINED) return dflt;
  double d = to_number(v);
  if (d != d) d = 0;
  d = trunc(d);
  if (d < 0) d = d + len < 0 ? 0 : d + len;
  return d > len ? len : (int64_t)d;
}

/* A method call on a string or an array: the builtins this slice covers. */
static yk call_method_key(yk recv, yk key, uint64_t argc, const yk *argv);
static yk make_error(const char *name, yk message);
_Noreturn void yk_throw(yk v);
/* A method call by a key the lowered code keeps (its string, made once). */
yk yk_call_method_k(yk recv, yk key, uint64_t argc, const yk *argv) { return call_method_key(recv, key, argc, argv); }
/* s.charCodeAt(i) (#1369): a string's unit at a number index, at once; else the method call. */
yk yk_char_code_at(yk recv, yk key, yk i) {
  if (is_string(recv) && is_number(i)) {
    double d = num(i);
    d = d != d ? 0 : trunc(d);
    yk_string *s = str(recv);
    return d < 0 || d >= s->len ? yk_number(NAN) : yk_number(s->units[(int64_t)d]);
  }
  return call_method_key(recv, key, 1, &i);
}
yk yk_call_method(yk recv, const char *name, uint64_t n, uint64_t argc, const yk *argv) {
  return call_method_key(recv, interned(name, n), argc, argv);
}
static yk bound_new(yk target, yk self, uint64_t argc, const yk *argv);
/* A method call by its key: the receiver's own (or inherited) method, else the runtime's own
   implementation for its type; anything else is a TypeError. */
/* The method a value's chain (or its intrinsic prototype) gives for a key is one of the runtime's thunks. */
static int inherits_thunk(yk recv, yk key) {
  yk f;
  if (chain_get(recv, key, &f)) return is_thunk(f);
  return is_thunk(proto_lookup(recv, key));
}
static yk call_method_key(yk recv, yk key, uint64_t argc, const yk *argv) {
  /* The member read the call makes first: of undefined or null, its TypeError. */
  if (is_nullish(recv)) yk_get(recv, key);
  yk arg0 = argc > 0 ? argv[0] : YK_UNDEFINED;
  yk arg1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  if (is_symbol(recv)) {
    yk m;
    if (symbol_member(recv, key, &m) && is_closure(m)) return call_value(m, recv, argc, argv);
  }
  if (is_regexp(recv)) {
    if (key_is(key, "exec")) return regexp_exec(recv, arg0);
    if (key_is(key, "test")) return yk_bool(regexp_exec(recv, arg0) != YK_NULL);
    if (key_is(key, "toString")) return to_primitive(recv);
  }
  if (is_string(recv)) {
    yk out;
    if (string_pattern_method(recv, key, argc, argv, &out)) return out;
  }
  if (is_object(recv)) {
    yk_object *o = (yk_object *)PTR(recv);
    yk f;
    if (o->kind == 10) {
      yk out;
      if (date_method(recv, key, argc, argv, &out)) return out;
    }
    if (o->kind == 11 && key_is(key, "deref")) return *(yk *)o->ext;
    if (o->kind == 12 && (key_is(key, "register") || key_is(key, "unregister")))
      return key_is(key, "register") ? YK_UNDEFINED : YK_FALSE;
    if (o->kind == 4 || o->kind == 5 || o->kind == 9) {
      yk m = async_member(o, key);
      if (m != 0) return call_value(m, recv, argc, argv);
    }
    if (o->kind >= 6 && o->kind <= 8) {
      yk out;
      /* Its own property or its chain's first (a subclass's method; one set on it, #1370). */
      if (chain_get(recv, key, &f) && !is_thunk(f = resolve_slot(f, recv)))
        return call_value(f, recv, argc, argv); /* a subclass's own method (Buffer's toString) */
      if (buffer_method(recv, key, argc, argv, &out)) return out;
    }
    if (o->kind == 1 || o->kind == 2) {
      yk out;
      /* Its own property (TypeScript's multi-map sets add on a Map) or its chain's first. */
      if (chain_get(recv, key, &f) && !is_thunk(f = resolve_slot(f, recv)))
        return call_value(f, recv, argc, argv); /* a subclass's own method */
      if (collection_method(o, recv, key, argc, argv, &out)) return out;
    } else if (chain_get(recv, key, &f) && !is_thunk(f = resolve_slot(f, recv)))
      return call_value(f, recv, argc, argv);
  }
  if (is_closure(recv)) {
    yk f;
    if (chain_get(recv, key, &f) && !is_thunk(f = resolve_slot(f, recv))) return call_value(f, recv, argc, argv);
    if (key_is(key, "call")) return call_value(recv, arg0, argc > 0 ? argc - 1 : 0, argv + (argc > 0 ? 1 : 0));
    if (key_is(key, "apply")) {
      /* CreateListFromArrayLike of the second argument (undefined and null: no arguments). */
      if (is_nullish(arg1)) return call_value(recv, arg0, 0, NULL);
      if (is_array(arg1)) return call_value(recv, arg0, arr(arg1)->len, arr(arg1)->items);
      if (!is_object(arg1) && !is_closure(arg1)) type_error("CreateListFromArrayLike called on non-object");
      double n = to_number(yk_get(arg1, ascii("length")));
      yk_array *list = new_array(4);
      for (double i = 0; i < n; i++) push(list, yk_get(arg1, yk_number(i)));
      return call_value(recv, arg0, list->len, list->items);
    }
    if (key_is(key, "bind")) return bound_new(recv, arg0, argc > 0 ? argc - 1 : 0, argv + (argc > 0 ? 1 : 0));
  }
  if (is_array(recv)) {
    yk out;
    /* A method set on the array itself comes before Array.prototype's (#1370). */
    if (arr(recv)->props != 0 && own_get((yk_object *)PTR(arr(recv)->props), key, &out))
      return call_value(resolve_slot(out, recv), recv, argc, argv);
    if (array_callback_method(recv, key, argc, argv, &out)) return out;
    if (key_is(key, "values") || key == symbol_iterator()) return builtin_iter_new(recv, 1, 0);
    if (key_is(key, "keys")) return builtin_iter_new(recv, 0, 0);
    if (key_is(key, "entries")) return builtin_iter_new(recv, 2, 0);
  }
  if (is_array(recv)) {
    yk out;
    if (array_more_method(recv, key, argc, argv, &out)) return out;
  }
  if (is_string(recv) && key == symbol_iterator()) return builtin_iter_new(recv, 1, 1);
  if (is_builtin_iter(recv) && key_is(key, "next")) {
    yk v;
    int more = builtin_iter_step(recv, &v);
    return iter_result(more ? v : YK_UNDEFINED, !more);
  }
  if (is_string(recv)) {
    yk_string *s0 = str(recv);
    if (key_is(key, "toUpperCase") || key_is(key, "toLocaleUpperCase")) return case_convert(recv, 1);
    if (key_is(key, "toLowerCase") || key_is(key, "toLocaleLowerCase")) return case_convert(recv, 0);
    if (key_is(key, "includes") || key_is(key, "startsWith") || key_is(key, "endsWith")) {
      yk_string *t = str(to_string(arg0));
      int64_t len = s0->len;
      if (key_is(key, "endsWith")) {
        int64_t end = arg1 == YK_UNDEFINED ? len : relative(arg1, len, len);
        if (arg1 != YK_UNDEFINED && to_number(arg1) < 0) end = 0;
        int64_t start = end - t->len;
        return yk_bool(start >= 0 && memcmp(s0->units + start, t->units, (size_t)t->len * 2) == 0);
      }
      int64_t from = relative(arg1, len, 0);
      if (arg1 != YK_UNDEFINED && to_number(arg1) < 0) from = 0;
      if (key_is(key, "startsWith"))
        return yk_bool(from + t->len <= len && memcmp(s0->units + from, t->units, (size_t)t->len * 2) == 0);
      for (int64_t i = from; i + t->len <= len; i++)
        if (memcmp(s0->units + i, t->units, (size_t)t->len * 2) == 0) return YK_TRUE;
      return YK_FALSE;
    }
    if (key_is(key, "padStart") || key_is(key, "padEnd")) {
      /* StringPad: to ToLength(maxLength) units, with the filler (default " ") repeated, cut. */
      double max = to_number(arg0);
      if (max != max) max = 0;
      yk_string *fill = str(arg1 == YK_UNDEFINED ? ascii(" ") : to_string(arg1));
      if (max <= s0->len || fill->len == 0) return recv;
      if (max > 536870888) range_error("Invalid string length");
      uint32_t total = (uint32_t)max, pad = total - s0->len;
      yk_string *r = new_string(total);
      int start = key_is(key, "padStart");
      uint32_t at = start ? 0 : s0->len;
      for (uint32_t i = 0; i < pad; i++) r->units[at + i] = fill->units[i % fill->len];
      memcpy(r->units + (start ? pad : 0), s0->units, (size_t)s0->len * 2);
      return string_of(r);
    }
    if (key_is(key, "repeat")) {
      double c = to_number(arg0);
      if (c != c) c = 0;
      c = trunc(c);
      if (c < 0 || isinf(c)) range_error("Invalid count value");
      if (s0->len == 0 || c == 0) return ascii("");
      if (c * s0->len > 536870888) range_error("Invalid string length");
      yk_string *r = new_string((uint32_t)c * s0->len);
      for (uint32_t i = 0; i < (uint32_t)c; i++) memcpy(r->units + (size_t)i * s0->len, s0->units, (size_t)s0->len * 2);
      return string_of(r);
    }
    if (key_is(key, "lastIndexOf")) {
      yk_string *t = str(to_string(arg0));
      double p = arg1 == YK_UNDEFINED ? NAN : to_number(arg1);
      int64_t len = s0->len, from = p != p ? len : p < 0 ? 0 : p > len ? len : (int64_t)trunc(p);
      if (from > len - (int64_t)t->len) from = len - (int64_t)t->len;
      for (int64_t i = from; i >= 0; i--)
        if (memcmp(s0->units + i, t->units, (size_t)t->len * 2) == 0) return yk_number((double)i);
      return yk_number(-1);
    }
    if (key_is(key, "concat")) {
      yk r = recv;
      for (uint64_t i = 0; i < argc; i++) r = concat(str(r), str(to_string(argv[i])));
      return r;
    }
    if (key_is(key, "substring")) {
      /* Both ends clamped to [0, length] (NaN as 0), swapped when the start is the larger. */
      double a = arg0 == YK_UNDEFINED ? 0 : to_number(arg0), b = arg1 == YK_UNDEFINED ? s0->len : to_number(arg1);
      a = a != a ? 0 : a < 0 ? 0 : a > s0->len ? s0->len : trunc(a);
      b = b != b ? 0 : b < 0 ? 0 : b > s0->len ? s0->len : trunc(b);
      if (a > b) { double t = a; a = b; b = t; }
      return substring(s0, (uint32_t)a, (uint32_t)b);
    }
    if (key_is(key, "charAt")) {
      double d = arg0 == YK_UNDEFINED ? 0 : to_number(arg0);
      d = d != d ? 0 : trunc(d);
      return d < 0 || d >= s0->len ? ascii("") : substring(s0, (uint32_t)d, (uint32_t)d + 1);
    }
    if (key_is(key, "isWellFormed") || key_is(key, "toWellFormed")) {
      /* A lone surrogate: not well formed; toWellFormed puts U+FFFD in its place. */
      int to = key_is(key, "toWellFormed"), ok = 1;
      yk_string *r = to ? new_string(s0->len) : NULL;
      for (uint32_t i = 0; i < s0->len; i++) {
        uint16_t c = s0->units[i];
        int lone = 0;
        if (c >= 0xD800 && c <= 0xDBFF) {
          if (i + 1 < s0->len && s0->units[i + 1] >= 0xDC00 && s0->units[i + 1] <= 0xDFFF) {
            if (to) r->units[i] = c, r->units[i + 1] = s0->units[i + 1];
            i++;
            continue;
          }
          lone = 1;
        } else if (c >= 0xDC00 && c <= 0xDFFF) lone = 1;
        if (lone) ok = 0;
        if (to) r->units[i] = lone ? 0xFFFD : c;
      }
      return to ? string_of(r) : yk_bool(ok);
    }
    {
      /* Annex B's HTML methods: the string in a tag, an attribute's quotes as &quot;. */
      static const char *const html[][3] = {{"anchor", "a", "name"}, {"big", "big", NULL}, {"blink", "blink", NULL},
                                            {"bold", "b", NULL}, {"fixed", "tt", NULL}, {"fontcolor", "font", "color"},
                                            {"fontsize", "font", "size"}, {"italics", "i", NULL}, {"link", "a", "href"},
                                            {"small", "small", NULL}, {"strike", "strike", NULL}, {"sub", "sub", NULL},
                                            {"sup", "sup", NULL}};
      for (size_t h = 0; h < sizeof html / sizeof html[0]; h++) {
        if (!key_is(key, html[h][0])) continue;
        yk open = concat(str(ascii("<")), str(ascii(html[h][1])));
        if (html[h][2] != NULL) {
          yk_string *v = str(to_string(arg0));
          yk q = ascii("");
          uint32_t last = 0;
          for (uint32_t i = 0; i < v->len; i++)
            if (v->units[i] == '"') {
              q = concat(str(q), str(substring(v, last, i)));
              q = concat(str(q), str(ascii("&quot;")));
              last = i + 1;
            }
          q = concat(str(q), str(substring(v, last, v->len)));
          open = concat(str(open), str(ascii(" ")));
          open = concat(str(open), str(ascii(html[h][2])));
          open = concat(str(open), str(ascii("=\"")));
          open = concat(str(open), str(q));
          open = concat(str(open), str(ascii("\"")));
        }
        open = concat(str(open), str(ascii(">")));
        open = concat(str(open), s0);
        open = concat(str(open), str(ascii("</")));
        open = concat(str(open), str(ascii(html[h][1])));
        return concat(str(open), str(ascii(">")));
      }
    }
    if (key_is(key, "trimStart") || key_is(key, "trimEnd") || key_is(key, "trimLeft") || key_is(key, "trimRight")) {
      uint32_t a = 0, b = s0->len;
      if (key_is(key, "trimStart") || key_is(key, "trimLeft")) while (a < b && is_space(s0->units[a])) a++;
      else while (b > a && is_space(s0->units[b - 1])) b--;
      yk_string *r = new_string(b - a);
      memcpy(r->units, s0->units + a, (size_t)(b - a) * 2);
      return string_of(r);
    }
    if (key_is(key, "trim")) {
      uint32_t a = 0, b = s0->len;
      while (a < b && is_space(s0->units[a])) a++;
      while (b > a && is_space(s0->units[b - 1])) b--;
      yk_string *r = new_string(b - a);
      memcpy(r->units, s0->units + a, (size_t)(b - a) * 2);
      return string_of(r);
    }
    if (key_is(key, "split")) {
      yk_array *r = new_array(4);
      if (arg0 == YK_UNDEFINED) {
        push(r, recv);
        return BOX(T_ARRAY, r);
      }
      yk_string *sep = str(to_string(arg0));
      if (sep->len == 0) {
        for (uint32_t i = 0; i < s0->len; i++) {
          yk_string *c = new_string(1);
          c->units[0] = s0->units[i];
          push(r, string_of(c));
        }
        return BOX(T_ARRAY, r);
      }
      uint32_t start = 0;
      for (uint32_t i = 0; i + sep->len <= s0->len;) {
        if (memcmp(s0->units + i, sep->units, (size_t)sep->len * 2) == 0) {
          yk_string *part = new_string(i - start);
          memcpy(part->units, s0->units + start, (size_t)(i - start) * 2);
          push(r, string_of(part));
          i += sep->len;
          start = i;
        } else
          i++;
      }
      yk_string *last = new_string(s0->len - start);
      memcpy(last->units, s0->units + start, (size_t)(s0->len - start) * 2);
      push(r, string_of(last));
      return BOX(T_ARRAY, r);
    }
  }
  if (is_string(recv)) {
    yk_string *s = str(recv);
    if (key_is(key, "codePointAt")) {
      double d = to_number(arg0);
      d = d != d ? 0 : trunc(d);
      if (d < 0 || d >= s->len) return YK_UNDEFINED;
      uint32_t i = (uint32_t)d;
      uint16_t hi = s->units[i];
      if (hi >= 0xD800 && hi <= 0xDBFF && i + 1 < s->len && s->units[i + 1] >= 0xDC00 && s->units[i + 1] <= 0xDFFF)
        return yk_number(0x10000 + ((hi - 0xD800) << 10) + (s->units[i + 1] - 0xDC00));
      return yk_number(hi);
    }
    if (key_is(key, "charCodeAt")) {
      double d = to_number(arg0);
      d = d != d ? 0 : trunc(d);
      return d < 0 || d >= s->len ? yk_number(NAN) : yk_number(s->units[(int64_t)d]);
    }
    if (key_is(key, "substr")) {
      /* Annex B's substr(start, length): start as slice's, then at most length units. */
      int64_t a = relative(arg0, s->len, 0), n = s->len - a;
      if (arg1 != YK_UNDEFINED) {
        double l = to_number(arg1);
        l = l != l ? 0 : trunc(l);
        if (l < (double)n) n = l <= 0 ? 0 : (int64_t)l;
      }
      yk_string *r = new_string((uint32_t)n);
      memcpy(r->units, s->units + a, (size_t)n * 2);
      return string_of(r);
    }
    if (key_is(key, "slice")) {
      int64_t a = relative(arg0, s->len, 0), b = relative(arg1, s->len, s->len);
      yk_string *r = new_string(b > a ? (uint32_t)(b - a) : 0);
      if (b > a) memcpy(r->units, s->units + a, (size_t)(b - a) * 2);
      return string_of(r);
    }
    if (key_is(key, "indexOf")) {
      yk_string *t = str(to_string(arg0));
      int64_t from = relative(arg1, s->len, 0);
      if (arg1 != YK_UNDEFINED && to_number(arg1) < 0) from = 0;
      for (int64_t i = from; i + t->len <= s->len; i++)
        if (memcmp(s->units + i, t->units, (size_t)t->len * 2) == 0) return yk_number((double)i);
      return yk_number(-1);
    }
  }
  if (is_array(recv)) {
    yk_array *a = arr(recv);
    if (key_is(key, "push")) {
      for (uint64_t i = 0; i < argc; i++) push(a, argv[i]);
      return yk_number(a->len);
    }
    if (key_is(key, "pop")) return a->len == 0 ? YK_UNDEFINED : a->items[--a->len];
    if (key_is(key, "shift")) {
      a->holes = NULL, a->holes_n = 0;
      if (a->len == 0) return YK_UNDEFINED;
      yk first = a->items[0];
      memmove(a->items, a->items + 1, (size_t)(a->len - 1) * sizeof(yk));
      a->len--;
      return first;
    }
    if (key_is(key, "unshift")) {
      a->holes = NULL, a->holes_n = 0;
      for (uint64_t i = 0; i < argc; i++) push(a, YK_UNDEFINED);
      memmove(a->items + argc, a->items, (size_t)(a->len - argc) * sizeof(yk));
      for (uint64_t i = 0; i < argc; i++) a->items[i] = argv[i];
      return yk_number(a->len);
    }
    if (key_is(key, "indexOf")) {
      for (int64_t i = relative(arg1, a->len, 0); i < a->len; i++)
        if (strict_equal(a->items[i], arg0) && !array_hole(a, (uint32_t)i)) return yk_number((double)i);
      return yk_number(-1);
    }
    if (key_is(key, "slice")) {
      int64_t s0 = relative(arg0, a->len, 0), s1 = relative(arg1, a->len, a->len);
      yk_array *r = new_array(s1 > s0 ? (uint32_t)(s1 - s0) : 0);
      for (int64_t i = s0; i < s1; i++) {
        push(r, a->items[i]);
        if (array_hole(a, (uint32_t)i)) array_mark_hole(r, (uint32_t)(i - s0), 1);
      }
      return BOX(T_ARRAY, r);
    }
    if (key_is(key, "join"))
      return array_join(a, str(arg0 == YK_UNDEFINED ? ascii(",") : to_string(arg0)));
  }
  if ((is_number(recv) || is_bool(recv) || is_bigint(recv)) && key_is(key, "toString")) {
    if (is_number(recv) && arg0 != YK_UNDEFINED) {
      double r = trunc(to_number(arg0));
      if (!(r >= 2 && r <= 36)) range_error("toString() radix must be between 2 and 36");
      if (r != 10) return number_to_radix(num(recv), (int)r);
    }
    return to_string(recv);
  }
  if ((is_number(recv) || is_bool(recv) || is_bigint(recv)) && key_is(key, "valueOf")) return recv;
  if (is_number(recv) && (key_is(key, "toFixed") || key_is(key, "toPrecision") || key_is(key, "toExponential")))
    return number_format(num(recv), key_is(key, "toFixed") ? 0 : key_is(key, "toPrecision") ? 1 : 2, arg0);
  {
    /* A method the program put on an intrinsic prototype (not one of the runtime's thunks). */
    yk f = proto_lookup(recv, key);
    if (is_closure(f) && ((yk_closure *)PTR(f))->code != method_thunk_code &&
        ((yk_closure *)PTR(f))->code != object_thunk_code)
      return call_value(f, recv, argc, argv);
  }
  /* Object.prototype's methods, for every receiver (and Array.prototype.toString, String's). */
  if (key_is(key, "hasOwnProperty") || key_is(key, "propertyIsEnumerable")) return yk_bool(has_own(recv, arg0));
  if (key_is(key, "isPrototypeOf")) {
    for (yk p = is_object(arg0) ? ((yk_object *)PTR(arg0))->proto : 0; is_object(p); p = ((yk_object *)PTR(p))->proto)
      if (p == recv) return YK_TRUE;
    return yk_bool(is_object(arg0) && recv == tail_proto(arg0));
  }
  if (key_is(key, "toString") || key_is(key, "toLocaleString")) {
    if (is_array(recv)) return array_join(arr(recv), str(ascii(",")));
    if (is_string(recv)) return recv;
    if (is_symbol(recv)) return symbol_descriptive(recv);
    if (is_object(recv) && ((yk_object *)PTR(recv))->error) return to_string(recv);
    return object_to_string(recv);
  }
  if (key_is(key, "valueOf")) return recv;
  /* %IteratorPrototype%[Symbol.iterator]: the iterator itself. */
  if ((key == symbol_iterator() || key == symbol_async_iterator()) && (is_object(recv) || is_closure(recv)) &&
      inherits_thunk(recv, key))
    return recv;
  /* Array.prototype's iterators on an array-like (Array.prototype itself among them). */
  if ((key_is(key, "keys") || key_is(key, "values") || key_is(key, "entries")) && (is_object(recv) || is_closure(recv)) &&
      inherits_thunk(recv, key))
    return builtin_iter_new(recv, key_is(key, "keys") ? 0 : key_is(key, "values") ? 1 : 2, 0);
  yk desc = is_symbol(key) ? symbol_descriptive(key) : key;
  yk_throw(make_error("TypeError", concat(str(to_string(desc)), str(ascii(" is not a function here")))));
  return YK_UNDEFINED;
}
/* A bound function (Function.prototype.bind): its target, this and leading arguments. */
static yk bound_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  yk_closure *b = (yk_closure *)c;
  uint32_t k = b->n - 2;
  yk_array *args = new_array(k + (uint32_t)argc + 1);
  for (uint32_t i = 0; i < k; i++) push(args, b->captures[2 + i]);
  for (uint64_t i = 0; i < argc; i++) push(args, argv[i]);
  return call_value(b->captures[0], b->captures[1], args->len, args->items);
}
static yk bound_new(yk target, yk self, uint64_t argc, const yk *argv) {
  if (!is_closure(target)) type_error("Bind must be called on a function");
  yk_array *caps = new_array((uint32_t)argc + 2);
  push(caps, target);
  push(caps, self);
  for (uint64_t i = 0; i < argc; i++) push(caps, argv[i]);
  return yk_closure_new(bound_code, 0, caps->len, caps->items);
}

/* --- objects --- */

/* A key's hash, as key_equal compares: a string's by its code units, anything else by its bits. */
static uint32_t key_hash(yk key) {
  uint64_t h = 1469598103934665603ull;
  if (is_string(key)) {
    yk_string *s = str(key);
    for (uint32_t i = 0; i < s->len; i++) h = (h ^ s->units[i]) * 1099511628211ull;
  } else
    h = (key ^ (key >> 29)) * 0x9E3779B97F4A7C15ull;
  return (uint32_t)(h ^ (h >> 32));
}
static void own_index_put(yk_object *o, uint32_t i) {
  uint32_t mask = o->index_cap - 1;
  for (uint32_t j = key_hash(o->keys[i]) & mask;; j = (j + 1) & mask)
    if (o->index[j] == 0) {
      o->index[j] = i + 1;
      return;
    }
}
static void own_index_build(yk_object *o) {
  uint32_t cap = 16;
  while (cap < o->len * 4) cap *= 2;
  o->index = alloc((size_t)cap * sizeof(uint32_t));
  memset(o->index, 0, (size_t)cap * sizeof(uint32_t));
  o->index_cap = cap;
  for (uint32_t i = 0; i < o->len; i++) own_index_put(o, i);
}
/* A key's position among an object's own, or -1: by its index once it has 8 keys or more. */
/* The positions own_find last found in objects of 8 keys or more, by object and key (#1369): a hit
   is that key still at that position (an object holds a key once), so no hash is computed. */
static struct {
  yk_object *o;
  yk key;
  uint32_t at;
} own_found[512];
static int64_t own_find(yk_object *o, yk key) {
  if (o->len < 8) {
    for (uint32_t i = 0; i < o->len; i++)
      if (key_equal(o->keys[i], key)) return i;
    return -1;
  }
  uint32_t slot = (uint32_t)((((uintptr_t)o >> 4) ^ (key >> 3) ^ (key >> 13)) & 511);
  if (own_found[slot].o == o && own_found[slot].key == key && own_found[slot].at < o->len &&
      o->keys[own_found[slot].at] == key)
    return own_found[slot].at;
  if (o->index == NULL) own_index_build(o);
  uint32_t mask = o->index_cap - 1;
  for (uint32_t j = key_hash(key) & mask;; j = (j + 1) & mask) {
    uint32_t at = o->index[j];
    if (at == 0) return -1;
    if (key_equal(o->keys[at - 1], key)) {
      own_found[slot].o = o, own_found[slot].key = key, own_found[slot].at = at - 1;
      return at - 1;
    }
  }
}
/* A key given as its characters (an integer's digits): its position among an object's own, or -1. */
static int64_t own_find_chars(yk_object *o, const char *p, uint32_t n) {
  if (o->len >= 8) {
    if (o->index == NULL) own_index_build(o);
    uint64_t h = 1469598103934665603ull;
    for (uint32_t i = 0; i < n; i++) h = (h ^ (uint8_t)p[i]) * 1099511628211ull;
    uint32_t mask = o->index_cap - 1;
    for (uint32_t j = (uint32_t)(h ^ (h >> 32)) & mask;; j = (j + 1) & mask) {
      uint32_t at = o->index[j];
      if (at == 0) return -1;
      yk k = o->keys[at - 1];
      if (is_string(k) && str(k)->len == n) {
        uint32_t i = 0;
        while (i < n && str(k)->units[i] == (uint8_t)p[i]) i++;
        if (i == n) return at - 1;
      }
    }
  }
  for (uint32_t at = 0; at < o->len; at++) {
    yk k = o->keys[at];
    if (is_string(k) && str(k)->len == n) {
      uint32_t i = 0;
      while (i < n && str(k)->units[i] == (uint8_t)p[i]) i++;
      if (i == n) return at;
    }
  }
  return -1;
}
static int own_get(yk_object *o, yk key, yk *out) {
  int64_t i = own_find(o, key);
  if (i < 0) return 0;
  *out = o->values[i];
  return 1;
}

static void own_set(yk_object *o, yk key, yk value) {
  int64_t found = own_find(o, key);
  if (found >= 0) {
    o->values[found] = value;
    return;
  }
  if (o->len == o->cap) {
    o->cap = o->cap < 4 ? 4 : o->cap * 2;
    yk *k = alloc((size_t)o->cap * sizeof(yk)), *v = alloc((size_t)o->cap * sizeof(yk));
    memcpy(k, o->keys, (size_t)o->len * sizeof(yk));
    memcpy(v, o->values, (size_t)o->len * sizeof(yk));
    o->keys = k;
    o->values = v;
  }
  o->keys[o->len] = key;
  o->values[o->len++] = value;
  note_digit_key(o, key);
  /* The index takes the new key while it is at most a quarter full; else it is made again. */
  if (o->index != NULL) {
    if (o->len * 4 > o->index_cap) o->index = NULL;
    else own_index_put(o, o->len - 1);
  }
}

/* --- accessors, prototypes, classes --- */

typedef struct {
  int32_t internal; /* 2: an accessor */
  yk get, set;      /* functions, or 0 */
} yk_accessor;

static int is_accessor(yk v) { return TAG(v) == T_INTERNAL && *(int32_t *)PTR(v) == 2; }

/* A slot's value as a read sees it: an accessor calls its getter on the receiver. */
static yk resolve_slot(yk slot, yk receiver) {
  if (!is_accessor(slot)) return slot;
  yk getter = ((yk_accessor *)PTR(slot))->get;
  return getter == 0 ? YK_UNDEFINED : call_value(getter, receiver, 0, NULL);
}

static yk ensure_prototype(yk f);

/* The object holding a value's own properties: an object itself, or a function's property object. */
static yk_object *own_props(yk v) {
  if (is_object(v)) return (yk_object *)PTR(v);
  yk_closure *c = (yk_closure *)PTR(v);
  if (c->props == 0) c->props = yk_object_of(0, NULL, NULL);
  return (yk_object *)PTR(c->props);
}

/* A property along the prototype chain: its slot (perhaps an accessor). */
static int chain_get(yk obj, yk key, yk *out) {
  if (is_closure(obj)) {
    yk_closure *c = (yk_closure *)PTR(obj);
    /* A function's prototype exists from its first use, as `F.prototype.m = …` needs. */
    if ((c->has_this || c->is_class || c->mode == 2 || c->mode == 3) && key_is(key, "prototype")) ensure_prototype(obj);
    if (c->props != 0 && own_get((yk_object *)PTR(c->props), key, out)) return 1;
    /* Its name and length, unless written. */
    if (is_string(key) && key_is(key, "name")) return *out = c->fname != 0 ? c->fname : ascii(""), 1;
    if (is_string(key) && key_is(key, "length")) return *out = yk_number(c->flen), 1;
    /* A derived class inherits its parent's statics. */
    return c->parent != 0 && is_closure(c->parent) && chain_get(c->parent, key, out);
  }
  for (yk v = obj; v != 0 && is_object(v); v = ((yk_object *)PTR(v))->proto)
    if (own_get((yk_object *)PTR(v), key, out)) return 1;
  return 0;
}

static yk generator_proto(int async);
static yk ensure_prototype(yk f) {
  yk_closure *c = (yk_closure *)PTR(f);
  yk p;
  if (c->props != 0 && own_get((yk_object *)PTR(c->props), ascii("prototype"), &p)) return p;
  if (c->mode == 2 || c->mode == 3) {
    /* A generator function's prototype: its generators', with no constructor, inheriting
       %GeneratorPrototype% (%AsyncGeneratorPrototype%). */
    p = yk_object_of(0, NULL, NULL);
    ((yk_object *)PTR(p))->proto = generator_proto(c->mode == 3);
    own_set(own_props(f), ascii("prototype"), p);
    return p;
  }
  yk key = ascii("constructor");
  p = yk_object_of(1, &key, &f);
  own_set(own_props(f), ascii("prototype"), p);
  return p;
}

/* An accessor slot on an object: its getter or setter, merged with the other if there is one. */
static void define_accessor(yk_object *o, yk key, yk getter, yk setter) {
  yk slot;
  if (own_get(o, key, &slot) && is_accessor(slot)) {
    yk_accessor *a = (yk_accessor *)PTR(slot);
    if (getter != 0) a->get = getter;
    if (setter != 0) a->set = setter;
    return;
  }
  yk_accessor *a = alloc(sizeof(yk_accessor));
  a->internal = 2;
  a->get = getter;
  a->set = setter;
  own_set(o, key, BOX(T_INTERNAL, a));
}

/* An object literal built slot by slot (when it has a spread or an accessor). */
yk yk_define(yk obj, yk key, yk value) {
  own_set((yk_object *)PTR(obj), to_property_key(key), value);
  return obj;
}
/* An object literal's `__proto__: v` (B.3.1): an object becomes the prototype; anything else
   (null among them) leaves the object as it is; no property is defined. */
yk yk_object_set_proto(yk obj, yk proto) {
  if (is_object(proto)) ((yk_object *)PTR(obj))->proto = proto;
  else if (proto == YK_NULL) ((yk_object *)PTR(obj))->proto = YK_NULL;
  return obj;
}
yk yk_define_accessor(yk obj, yk key, yk getter, yk setter) {
  define_accessor((yk_object *)PTR(obj), to_property_key(key), getter == YK_UNDEFINED ? 0 : getter,
                  setter == YK_UNDEFINED ? 0 : setter);
  return obj;
}

/* A class (kinds: 0 constructor, 1 method, 2 getter, 3 setter, 4 field, 5 static block, 8 more for
   a private name; each static or not). A field's member is its initializer; a computed name is the
   key's value (#1330). */
static yk default_constructor(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self, (void)argc, (void)argv;
  return YK_UNDEFINED;
}
static yk builtin_error(void *, yk, uint64_t, const yk *);
static yk builtin_type_error(void *, yk, uint64_t, const yk *);
static yk builtin_range_error(void *, yk, uint64_t, const yk *);
static yk builtin_syntax_error(void *, yk, uint64_t, const yk *);
static yk builtin_eval_error(void *, yk, uint64_t, const yk *);
static yk builtin_reference_error(void *, yk, uint64_t, const yk *);
static yk builtin_uri_error(void *, yk, uint64_t, const yk *);
static yk builtin_aggregate_error(void *, yk, uint64_t, const yk *);
static int is_adoptable_builtin(yk f);
static yk builtin_map(void *c, yk s, uint64_t argc, const yk *argv);
static yk builtin_set(void *c, yk s, uint64_t argc, const yk *argv);
yk yk_new(yk f, uint64_t argc, const yk *argv);
static int is_error_constructor(yk f) {
  if (!is_closure(f)) return 0;
  yk_code code = ((yk_closure *)PTR(f))->code;
  return code == builtin_error || code == builtin_type_error || code == builtin_range_error ||
         code == builtin_syntax_error || code == builtin_eval_error || code == builtin_reference_error ||
         code == builtin_uri_error || code == builtin_aggregate_error;
}
/* A class's instance fields, defined on a receiver in order, each initializer run with it as its
   receiver: by `new` for a base class before its constructor's body, and for a derived class when
   its super(..) returns (#1330). A field is defined, not assigned: a setter does not see it. */
/* --- private names (#1330): a private member is in its object's private table, keyed by the
   private name of one evaluation of one class; no enumeration, `in` or JSON sees the table --- */

/* A private method's slot: the method, not writable. */
typedef struct {
  int32_t internal; /* 3: a private method */
  yk method;
} yk_private_method;
static int is_private_method(yk v) { return TAG(v) == T_INTERNAL && *(int32_t *)PTR(v) == 3; }

static yk_object *privates_of(yk v, int create) {
  if (!is_object(v) && !is_closure(v)) return NULL;
  yk_object *o = own_props(v);
  if (o->privates == NULL && create) o->privates = PTR(yk_object_of(0, NULL, NULL));
  return (yk_object *)o->privates;
}

/* The key a private name means where it is written: that of the nearest class around the
   closure that declares it, as ECMAScript resolves it lexically. */
yk yk_private_key(void *closure, const char *name, uint64_t n) {
  yk want = yk_string_utf8(name, n);
  for (yk cls = closure == NULL ? 0 : ((yk_closure *)closure)->class_self; cls != 0;
       cls = ((yk_closure *)PTR(cls))->outer) {
    yk_closure *c = (yk_closure *)PTR(cls);
    for (uint32_t i = 0; i < c->npriv; i++)
      if (string_equal(str(c->priv_names[i]), str(want))) return c->priv_keys[i];
  }
  type_error("a private name is used outside a class that declares it");
  return YK_UNDEFINED;
}

yk yk_private_get(yk obj, yk key) {
  yk_object *p = privates_of(obj, 0);
  yk slot = 0;
  if (p == NULL || !own_get(p, key, &slot))
    type_error("Cannot read private member from an object whose class did not declare it");
  if (is_private_method(slot)) return ((yk_private_method *)PTR(slot))->method;
  if (is_accessor(slot)) {
    yk getter = ((yk_accessor *)PTR(slot))->get;
    if (getter == 0) type_error("'#' was defined without a getter");
    return call_value(getter, obj, 0, NULL);
  }
  return slot;
}

yk yk_private_set(yk obj, yk key, yk value) {
  yk_object *p = privates_of(obj, 0);
  yk slot = 0;
  if (p == NULL || !own_get(p, key, &slot))
    type_error("Cannot write private member to an object whose class did not declare it");
  if (is_private_method(slot)) type_error("Private method is not writable");
  if (is_accessor(slot)) {
    yk setter = ((yk_accessor *)PTR(slot))->set;
    if (setter == 0) type_error("'#' was defined without a setter");
    call_value(setter, obj, 1, &value);
    return value;
  }
  own_set(p, key, value);
  return value;
}

/* #x in o: whether o has the private member (its class's brand). */
yk yk_private_has(yk obj, yk key) {
  if (!is_object(obj) && !is_closure(obj)) type_error("Cannot use 'in' operator to search for a private field in a value that is not an object");
  yk_object *p = privates_of(obj, 0);
  yk slot;
  return yk_bool(p != NULL && own_get(p, key, &slot));
}

/* A private member of kind 2 (method), 3 (getter) or 4 (setter), or a private field's value. */
static void define_private(yk target, int kind, yk key, yk value) {
  yk_object *p = privates_of(target, 1);
  if (kind == 2) {
    yk_private_method *m = alloc(sizeof(yk_private_method));
    m->internal = 3;
    m->method = value;
    own_set(p, key, BOX(T_INTERNAL, m));
  } else if (kind == 3 || kind == 4)
    define_accessor(p, key, kind == 3 ? value : 0, kind == 4 ? value : 0);
  else
    own_set(p, key, value);
}

static void init_fields(yk cls, yk self) {
  yk_closure *c = (yk_closure *)PTR(cls);
  /* The private methods and accessors are the instance's before any field is (its brand). */
  for (uint32_t i = 0; i < c->nfields; i++)
    if (c->field_kind[i] >= 2) define_private(self, c->field_kind[i], c->field_keys[i], c->field_inits[i]);
  for (uint32_t i = 0; i < c->nfields; i++) {
    if (c->field_kind[i] >= 2) continue;
    yk_closure *init = (yk_closure *)PTR(c->field_inits[i]);
    yk v = init->code(init, self, 0, NULL);
    if (c->field_kind[i] == 1) define_private(self, 1, c->field_keys[i], v);
    else own_set((yk_object *)PTR(self), c->field_keys[i], v);
  }
}
/* super(args) in a derived constructor: the parent's constructor run on this receiver (#1294). */
yk yk_super_construct(void *closure, yk self, uint64_t argc, const yk *argv) {
  yk cls = ((yk_closure *)closure)->class_self;
  yk parent = cls == 0 ? 0 : ((yk_closure *)PTR(cls))->parent;
  if (parent == 0) type_error("'super' keyword unexpected here");
  if (is_error_constructor(parent)) {
    /* An Error subclass: the receiver is made an error, with the parent's name and message. */
    yk made = ((yk_closure *)PTR(parent))->code(NULL, YK_UNDEFINED, argc, argv);
    yk_object *o = (yk_object *)PTR(self), *e = (yk_object *)PTR(made);
    o->error = 1;
    for (uint32_t i = 0; i < e->len; i++) own_set(o, e->keys[i], e->values[i]);
    init_fields(cls, self);
    return self;
  }
  if (is_adoptable_builtin(parent)) {
    /* A built-in object constructor (Map, Set, Promise, …): its instance's internal state becomes the
       receiver's, which keeps its own prototype (the subclass's). */
    yk_code code = ((yk_closure *)PTR(parent))->code;
    int adder = (code == builtin_map || code == builtin_set) && argc > 0 && !is_nullish(argv[0]);
    yk made = yk_new(parent, adder ? 0 : argc, argv);
    yk_object *o = (yk_object *)PTR(self), *b = (yk_object *)PTR(made);
    o->kind = b->kind, o->entries = b->entries, o->ext = b->ext, o->regex = b->regex, o->error = b->error;
    for (uint32_t i = 0; i < b->len; i++) own_set(o, b->keys[i], b->values[i]);
    if (adder) {
      /* The entries go in through the receiver's set / add, a subclass's override included. */
      yk_array *items = iterable_items(argv[0]);
      for (uint32_t i = 0; i < items->len; i++) {
        yk e = items->items[i];
        if (code == builtin_set) call_method_key(self, ascii("add"), 1, &e);
        else {
          if (!is_array(e) && !is_object(e)) type_error("Iterator value is not an entry object");
          yk kv[2] = {yk_get(e, ascii("0")), yk_get(e, ascii("1"))};
          call_method_key(self, ascii("set"), 2, kv);
        }
      }
    }
    init_fields(cls, self);
    return self;
  }
  yk_closure *p = (yk_closure *)PTR(parent);
  /* A base parent's fields are defined before its body runs; a derived parent's by its super(). */
  if (p->is_class && p->parent == 0) init_fields(parent, self);
  yk r = p->code(p, self, argc, argv);
  if (is_reference(r)) return r;
  init_fields(cls, self);
  return self;
}
/* A derived class with no constructor of its own passes its arguments to its parent's. */
static yk default_derived_constructor(void *c, yk self, uint64_t argc, const yk *argv) {
  yk_super_construct(c, self, argc, argv);
  return YK_UNDEFINED;
}
/* super[key]: the parent's member by a key's value (#1330); super.name is it by a name. */
yk yk_super_get_key(void *closure, yk self, yk key) {
  yk_closure *c = (yk_closure *)closure;
  yk cls = c->class_self;
  yk parent = cls == 0 ? 0 : ((yk_closure *)PTR(cls))->parent;
  if (parent == 0 || !is_closure(parent)) return YK_UNDEFINED;
  key = to_property_key(key);
  yk slot;
  yk_closure *p = (yk_closure *)PTR(parent);
  yk base = c->home_static ? parent : (p->is_class || p->has_this || is_adoptable_builtin(parent)) ? ensure_prototype(parent) : 0;
  if (base == 0 || !chain_get(base, key, &slot)) return YK_UNDEFINED;
  return resolve_slot(slot, self);
}
/* super.name: the parent's member (its prototype's, or for a static member the parent's own),
   read with this function's receiver (#1294). */
yk yk_super_get(void *closure, yk self, const char *name, uint64_t n) {
  yk_closure *c = (yk_closure *)closure;
  yk cls = c->class_self;
  yk parent = cls == 0 ? 0 : ((yk_closure *)PTR(cls))->parent;
  if (parent == 0 || !is_closure(parent)) return YK_UNDEFINED;
  yk key = yk_string_utf8(name, n), slot;
  yk_closure *p = (yk_closure *)PTR(parent);
  yk base = c->home_static ? parent : (p->is_class || p->has_this || is_adoptable_builtin(parent)) ? ensure_prototype(parent) : 0;
  if (base == 0 || !chain_get(base, key, &slot)) return YK_UNDEFINED;
  return resolve_slot(slot, self);
}
static void add_field(yk_closure *c, uint8_t kind, yk key, yk member) {
  c->field_keys = grow(c->field_keys, c->nfields * sizeof(yk), (c->nfields + 1) * sizeof(yk));
  c->field_inits = grow(c->field_inits, c->nfields * sizeof(yk), (c->nfields + 1) * sizeof(yk));
  c->field_kind = grow(c->field_kind, c->nfields, c->nfields + 1u);
  c->field_keys[c->nfields] = key;
  c->field_inits[c->nfields] = member;
  c->field_kind[c->nfields++] = kind;
}
/* The key of a private name this class declares: made once per evaluation of the class. */
static yk private_key_of(yk_closure *c, yk cls, yk name) {
  for (uint32_t i = 0; i < c->npriv; i++)
    if (string_equal(str(c->priv_names[i]), str(name))) return c->priv_keys[i];
  char suffix[40];
  int len = snprintf(suffix, sizeof suffix, "@%llx", (unsigned long long)cls);
  yk_string *nm = str(name), *k = new_string(nm->len + (uint32_t)len);
  memcpy(k->units, nm->units, (size_t)nm->len * 2);
  for (int j = 0; j < len; j++) k->units[nm->len + (uint32_t)j] = (uint16_t)suffix[j];
  c->priv_names = grow(c->priv_names, c->npriv * sizeof(yk), (c->npriv + 1) * sizeof(yk));
  c->priv_keys = grow(c->priv_keys, c->npriv * sizeof(yk), (c->npriv + 1) * sizeof(yk));
  c->priv_names[c->npriv] = name;
  c->priv_keys[c->npriv] = string_of(k);
  return c->priv_keys[c->npriv++];
}
yk yk_class_new(void *creator, yk parent, uint64_t n, const yk *kinds, const yk *names,
                const yk *statics, const yk *members) {
  if (parent != 0 && !is_closure(parent))
    type_error("Class extends value is not a constructor or null");
  if (parent != 0 && !is_error_constructor(parent)) {
    yk_closure *p = (yk_closure *)PTR(parent);
    if (!p->is_class && !p->has_this && !is_adoptable_builtin(parent))
      type_error("extending this constructor is not in the runtime yet");
  }
  yk cls = 0;
  for (uint64_t i = 0; i < n; i++)
    if (((int)num(kinds[i]) & 7) == 0) cls = members[i];
  if (cls == 0)
    cls = yk_closure_new(parent != 0 ? default_derived_constructor : default_constructor, 1, 0, NULL);
  yk_closure *c = (yk_closure *)PTR(cls);
  c->is_class = 1;
  c->has_this = 1;
  c->parent = parent;
  c->outer = creator == NULL ? 0 : ((yk_closure *)creator)->class_self;
  /* Its private names first: every member's code may use any of them. A member's kind is 8 more
     when its name is private (a computed key is a value, never a private name). */
  for (uint64_t i = 0; i < n; i++)
    if (num(kinds[i]) >= 8) private_key_of(c, cls, names[i]);
  yk proto = ensure_prototype(cls);
  if (parent != 0 && !is_error_constructor(parent))
    ((yk_object *)PTR(proto))->proto = ensure_prototype(parent);
  for (uint64_t i = 0; i < n; i++) {
    int kind = (int)num(kinds[i]) & 7;
    ((yk_closure *)PTR(members[i]))->class_self = cls;
    ((yk_closure *)PTR(members[i]))->home_static =
        kind != 0 && (statics[i] == YK_TRUE || kind == 5);
    if (kind == 0 || kind == 5) continue;
    int private = num(kinds[i]) >= 8;
    yk key = private ? private_key_of(c, cls, names[i]) : 0;
    if (kind == 4) {
      if (statics[i] == YK_TRUE) continue;
      /* An instance field: kept, in order, for each instance. */
      add_field(c, private ? 1 : 0, private ? key : to_property_key(names[i]), members[i]);
      continue;
    }
    if (private) {
      /* A private method or accessor: each instance's, or the class's own when static. */
      int pkind = kind == 1 ? 2 : kind == 2 ? 3 : 4;
      if (statics[i] == YK_TRUE) define_private(cls, pkind, key, members[i]);
      else add_field(c, (uint8_t)pkind, key, members[i]);
      continue;
    }
    yk_object *target = statics[i] == YK_TRUE ? own_props(cls) : (yk_object *)PTR(proto);
    yk name = to_property_key(names[i]);
    name_method(members[i], name, kind == 2 ? "get " : kind == 3 ? "set " : NULL);
    if (kind == 1) own_set(target, name, members[i]);
    else define_accessor(target, name, kind == 2 ? members[i] : 0, kind == 3 ? members[i] : 0);
  }
  c->class_self = cls;
  /* The static fields and blocks run now, in order, with the class as their receiver. */
  for (uint64_t i = 0; i < n; i++) {
    int kind = (int)num(kinds[i]) & 7;
    if (!(kind == 5 || (kind == 4 && statics[i] == YK_TRUE))) continue;
    yk_closure *m = (yk_closure *)PTR(members[i]);
    yk v = m->code(m, cls, 0, NULL);
    if (kind == 4 && num(kinds[i]) >= 8) define_private(cls, 1, private_key_of(c, cls, names[i]), v);
    else if (kind == 4) own_set(own_props(cls), to_property_key(names[i]), v);
  }
  return cls;
}
yk yk_closure_class(void *closure) {
  yk cls = ((yk_closure *)closure)->class_self;
  return cls == 0 ? YK_UNDEFINED : cls;
}
/* A closure made inside a class's member knows the class too. */
yk yk_closure_inherit(yk child, void *parent) {
  ((yk_closure *)PTR(child))->class_self = ((yk_closure *)parent)->class_self;
  ((yk_closure *)PTR(child))->home_static = ((yk_closure *)parent)->home_static;
  return child;
}

/* delete obj[key]: an own property removed; an array element becomes undefined. */
yk yk_delete(yk obj, yk key) {
  if (is_nullish(obj)) type_error("Cannot convert undefined or null to object");
  if (is_object(obj) || is_closure(obj)) {
    if (is_closure(obj) && ((yk_closure *)PTR(obj))->props == 0) return YK_TRUE;
    yk_object *o = own_props(obj);
    yk k = to_property_key(key);
    for (uint32_t i = 0; i < o->len; i++)
      if (key_equal(o->keys[i], k)) {
        memmove(o->keys + i, o->keys + i + 1, (size_t)(o->len - i - 1) * sizeof(yk));
        memmove(o->values + i, o->values + i + 1, (size_t)(o->len - i - 1) * sizeof(yk));
        o->len--;
        o->index = NULL; /* positions moved: made again when next needed */
        set_hidden(o, k, 0);
        break;
      }
  } else if (is_array(obj)) {
    int64_t i = index_of_key(key);
    if (i >= 0 && i < arr(obj)->len) arr(obj)->items[i] = YK_UNDEFINED, array_mark_hole(arr(obj), (uint32_t)i, 1);
  }
  return YK_TRUE;
}
yk yk_delete_named(yk obj, const char *name, uint64_t n) { return yk_delete(obj, yk_string_utf8(name, n)); }

/* An object literal whose keys the lowering knows are distinct strings: its arrays filled at once. */
yk yk_object_of_distinct(uint64_t n, const yk *keys, const yk *values) {
  /* One block: the object, then its keys, then its values (a later key past cap grows them apart). */
  uint32_t cap = n < 4 ? 4 : (uint32_t)n;
  yk_object *o = alloc(sizeof(yk_object) + (size_t)cap * 2 * sizeof(yk));
  o->keys = (yk *)(o + 1);
  o->values = o->keys + cap;
  memcpy(o->keys, keys, (size_t)n * sizeof(yk));
  memcpy(o->values, values, (size_t)n * sizeof(yk));
  o->len = (uint32_t)n;
  for (uint64_t i = 0; i < n; i++) note_digit_key(o, keys[i]);
  o->cap = cap;
  return BOX(T_OBJECT, o);
}
/* An object literal: its keys (by ToPropertyKey) and values, in source order. */
yk yk_object_of(uint64_t n, const yk *keys, const yk *values) {
  uint32_t cap = n < 4 ? 4 : (uint32_t)n;
  yk_object *o = alloc(sizeof(yk_object) + (size_t)cap * 2 * sizeof(yk));
  o->len = 0;
  o->error = 0;
  o->kind = 0;
  o->proto = 0;
  o->regex = NULL;
  o->entries = NULL;
  o->keys = (yk *)(o + 1);
  o->values = o->keys + cap;
  o->cap = cap;
  o->index = NULL;
  o->index_cap = 0;
  o->privates = NULL;
  o->ext = NULL;
  for (uint64_t i = 0; i < n; i++) own_set(o, to_property_key(keys[i]), values[i]);
  return BOX(T_OBJECT, o);
}

static yk make_error(const char *name, yk message) {
  yk keys[2] = {ascii("name"), ascii("message")};
  yk values[2] = {ascii(name), message};
  yk e = yk_object_of(2, keys, values);
  ((yk_object *)PTR(e))->error = 1;
  return e;
}

/* --- exceptions: a stack of handlers, unwound by longjmp --- */

typedef struct handler {
  jmp_buf env;
  struct handler *prev;
} handler;
static handler *handlers = NULL;
static yk thrown;

_Noreturn void yk_throw(yk v) {
  if (handlers == NULL) {
    yk_string *s = str(to_string(v));
    fputs("Uncaught ", stderr);
    for (uint32_t i = 0; i < s->len; i++) fputc(s->units[i] < 0x80 ? (int)s->units[i] : '?', stderr);
    fputc('\n', stderr);
    /* A program's uncaught exception exits 1, as Node's; the test harnesses see 70. */
    fflush(stdout);
    exit(program_mode ? 1 : 70);
  }
  thrown = v;
  longjmp(handlers->env, 1);
}

static void type_error(const char *what) { yk_throw(make_error("TypeError", ascii(what))); }

/* Calls f; 1 when it threw, with what it threw in *result, else 0 with its result. */
static int protected_call(yk f, uint64_t argc, const yk *argv, yk *result) {
  handler h;
  h.prev = handlers;
  handlers = &h;
  if (setjmp(h.env) == 0) {
    yk r = call_value(f, YK_UNDEFINED, argc, argv);
    handlers = h.prev;
    *result = r;
    return 0;
  }
  handlers = h.prev;
  *result = thrown;
  return 1;
}

/* obj[key] = value. The graph's write yields the object, as written. */
yk yk_set(yk obj, yk key, yk value) {
  if (is_object(obj) && ((yk_object *)PTR(obj))->kind == 7 && buffer_set(obj, key, value)) return obj;
  if (is_object(obj) || is_closure(obj)) {
    yk k = to_property_key(key), slot;
    /* A setter along the chain is called; otherwise the property is the object's own. */
    if (chain_get(obj, k, &slot) && is_accessor(slot)) {
      yk setter = ((yk_accessor *)PTR(slot))->set;
      if (setter == 0) type_error("Cannot set a property that has only a getter");
      call_value(setter, obj, 1, &value);
      return obj;
    }
    own_set(own_props(obj), k, value);
    return obj;
  }
  if (is_array(obj)) {
    yk_array *a = arr(obj);
    int64_t i = is_symbol(key) ? -1 : index_of_key(key);
    if (i < 0) {
      if (!is_symbol(key) && key_is(to_string(key), "length")) {
        double n = to_number(value);
        if (n < 0 || n != floor(n) || n > 4294967295.0) yk_throw(make_error("RangeError", ascii("Invalid array length")));
        uint32_t was = a->len;
        while (a->len < n) push(a, YK_UNDEFINED);
        a->len = (uint32_t)n;
        for (uint32_t j = was; j < a->len; j++) array_mark_hole(a, j, 1);
        return obj;
      }
      if (a->props == 0) a->props = yk_object_of(0, NULL, NULL);
      own_set((yk_object *)PTR(a->props), to_property_key(key), value);
      return obj;
    }
    uint32_t was = a->len;
    while (a->len <= i) push(a, YK_UNDEFINED);
    for (uint32_t j = was; j < (uint32_t)i; j++) array_mark_hole(a, j, 1);
    if (a->holes != NULL) array_mark_hole(a, (uint32_t)i, 0);
    a->items[i] = value;
    return obj;
  }
  type_error("Cannot create a property on a primitive");
  return obj;
}

yk yk_set_named(yk obj, const char *name, uint64_t n, yk value) {
  return yk_set(obj, interned(name, n), value);
}


/* --- the intrinsics (#1331): the built-ins' prototypes as objects ---
 *
 * Each of Object, Function, Array, String, Number, Boolean, Symbol, BigInt, Map, Set, Promise, RegExp
 * and Error has a prototype object (made on first use) whose methods are thunks: functions that call
 * the runtime's own implementation of the method on their receiver; its getters likewise. A property
 * a value does not have along its own chain is looked up in its type's intrinsic prototype, so a
 * built-in's methods are values (`[].join`, `f.call`), reflected on as Node's primordials do. Every
 * intrinsic prototype but Object.prototype inherits from it; Object.prototype's prototype is null.
 */
enum { I_OBJECT, I_FUNCTION, I_ARRAY, I_STRING, I_NUMBER, I_BOOLEAN, I_SYMBOL, I_BIGINT, I_MAP, I_SET,
       I_PROMISE, I_REGEXP, I_ERROR, I_WEAKMAP, I_WEAKSET, I_WEAKREF, I_FINREG, I_DATE, I_ITERATOR,
       I_ARRAY_ITERATOR, I_STRING_ITERATOR, I_MAP_ITERATOR, I_SET_ITERATOR, I_GENERATOR, I_ASYNC_ITERATOR,
       I_ASYNC_GENERATOR, I_ASYNC_FUNCTION, I_GENERATOR_FUNCTION, I_ASYNC_GENERATOR_FUNCTION,
       I_TYPED_ARRAY, I_ARRAY_BUFFER, I_DATA_VIEW, I_TA_BASE, N_INTRINSIC = I_TA_BASE + 11 };
static const struct {
  const char *name;
  const char *const *methods;
  const char *const *getters;
} intrinsic_table[N_INTRINSIC] = {
  {"Object", (const char *const[]){"hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "toLocaleString", NULL}, (const char *const[]){NULL}},
  {"Function", (const char *const[]){"apply", "bind", "call", "toString", NULL}, (const char *const[]){NULL}},
  {"Array", (const char *const[]){"at", "concat", "copyWithin", "fill", "find", "findIndex", "findLast", "findLastIndex", "lastIndexOf", "pop", "push", "reverse", "shift", "unshift", "slice", "sort", "splice", "includes", "indexOf", "join", "keys", "entries", "values", "forEach", "filter", "flat", "flatMap", "map", "every", "some", "reduce", "reduceRight", "toReversed", "toSorted", "toSpliced", "with", "toLocaleString", "toString", NULL}, (const char *const[]){NULL}},
  {"String", (const char *const[]){"anchor", "at", "big", "blink", "bold", "charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "fontcolor", "fontsize", "fixed", "includes", "indexOf", "isWellFormed", "italics", "lastIndexOf", "link", "localeCompare", "match", "matchAll", "normalize", "padEnd", "padStart", "repeat", "replace", "replaceAll", "search", "slice", "small", "split", "strike", "sub", "substr", "substring", "sup", "startsWith", "toString", "toWellFormed", "trim", "trimStart", "trimLeft", "trimEnd", "trimRight", "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toUpperCase", "valueOf", NULL}, (const char *const[]){NULL}},
  {"Number", (const char *const[]){"toExponential", "toFixed", "toPrecision", "toString", "valueOf", "toLocaleString", NULL}, (const char *const[]){NULL}},
  {"Boolean", (const char *const[]){"toString", "valueOf", NULL}, (const char *const[]){NULL}},
  {"Symbol", (const char *const[]){"toString", "valueOf", NULL}, (const char *const[]){"description", NULL}},
  {"BigInt", (const char *const[]){"toLocaleString", "toString", "valueOf", NULL}, (const char *const[]){NULL}},
  {"Map", (const char *const[]){"get", "set", "has", "delete", "clear", "entries", "forEach", "keys", "values", NULL}, (const char *const[]){"size", NULL}},
  {"Set", (const char *const[]){"has", "add", "delete", "clear", "entries", "forEach", "values", "keys", "union", "intersection", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom", NULL}, (const char *const[]){"size", NULL}},
  {"Promise", (const char *const[]){"then", "catch", "finally", NULL}, (const char *const[]){NULL}},
  {"RegExp", (const char *const[]){"exec", "compile", "toString", "test", NULL}, (const char *const[]){"dotAll", "flags", "global", "hasIndices", "ignoreCase", "multiline", "source", "sticky", "unicode", "unicodeSets", NULL}},
  {"Error", (const char *const[]){"toString", NULL}, (const char *const[]){NULL}},
  {"WeakMap", (const char *const[]){"delete", "get", "set", "has", NULL}, (const char *const[]){NULL}},
  {"WeakSet", (const char *const[]){"delete", "has", "add", NULL}, (const char *const[]){NULL}},
  {"WeakRef", (const char *const[]){"deref", NULL}, (const char *const[]){NULL}},
  {"FinalizationRegistry", (const char *const[]){"register", "unregister", NULL}, (const char *const[]){NULL}},
  {"Date", (const char *const[]){"toString", "toDateString", "toTimeString", "toISOString", "toUTCString", "toGMTString", "getDate", "setDate", "getDay", "getFullYear", "setFullYear", "getHours", "setHours", "getMilliseconds", "setMilliseconds", "getMinutes", "setMinutes", "getMonth", "setMonth", "getSeconds", "setSeconds", "getTime", "setTime", "getTimezoneOffset", "getUTCDate", "setUTCDate", "getUTCDay", "getUTCFullYear", "setUTCFullYear", "getUTCHours", "setUTCHours", "getUTCMilliseconds", "setUTCMilliseconds", "getUTCMinutes", "setUTCMinutes", "getUTCMonth", "setUTCMonth", "getUTCSeconds", "setUTCSeconds", "valueOf", "getYear", "setYear", "toJSON", "toLocaleString", "toLocaleDateString", "toLocaleTimeString", NULL}, (const char *const[]){NULL}},
  {"Iterator", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Array Iterator", (const char *const[]){"next", NULL}, (const char *const[]){NULL}},
  {"String Iterator", (const char *const[]){"next", NULL}, (const char *const[]){NULL}},
  {"Map Iterator", (const char *const[]){"next", NULL}, (const char *const[]){NULL}},
  {"Set Iterator", (const char *const[]){"next", NULL}, (const char *const[]){NULL}},
  {"Generator", (const char *const[]){"next", "return", "throw", NULL}, (const char *const[]){NULL}},
  {"AsyncIterator", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"AsyncGenerator", (const char *const[]){"next", "return", "throw", NULL}, (const char *const[]){NULL}},
  {"AsyncFunction", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"GeneratorFunction", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"AsyncGeneratorFunction", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"TypedArray", (const char *const[]){"entries", "keys", "values", "at", "copyWithin", "every", "fill", "filter", "find", "findIndex", "findLast", "findLastIndex", "forEach", "includes", "indexOf", "join", "lastIndexOf", "map", "reverse", "reduce", "reduceRight", "set", "slice", "some", "sort", "subarray", "toReversed", "toSorted", "with", "toLocaleString", "toString", NULL}, (const char *const[]){"buffer", "byteLength", "byteOffset", "length", NULL}},
  {"ArrayBuffer", (const char *const[]){"slice", "resize", "transfer", "transferToFixedLength", NULL}, (const char *const[]){"byteLength", "maxByteLength", "resizable", "detached", NULL}},
  {"DataView", (const char *const[]){"getInt8", "setInt8", "getUint8", "setUint8", "getInt16", "setInt16", "getUint16", "setUint16", "getInt32", "setInt32", "getUint32", "setUint32", "getFloat32", "setFloat32", "getFloat64", "setFloat64", "getBigInt64", "setBigInt64", "getBigUint64", "setBigUint64", NULL}, (const char *const[]){"buffer", "byteLength", "byteOffset", NULL}},
  {"Int8Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Uint8Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Uint8ClampedArray", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Int16Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Uint16Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Int32Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Uint32Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Float32Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"Float64Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"BigInt64Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
  {"BigUint64Array", (const char *const[]){NULL}, (const char *const[]){NULL}},
};
static yk intrinsic_protos[N_INTRINSIC];
#include "lengths.h"
/* A built-in method's length (Node's), or 0 when the table has none. */
static int method_length(const char *proto, const char *name) {
  for (size_t i = 0; i < sizeof method_lengths / sizeof method_lengths[0]; i++)
    if (strcmp(method_lengths[i].proto, proto) == 0 && strcmp(method_lengths[i].name, name) == 0)
      return method_lengths[i].length;
  return 0;
}
static int view_type(yk v);
static yk intrinsic_proto(int which);
static yk prototype_of(yk v);
static uint32_t ta_bytes(int type);
static const char *ta_name(int type);
/* An array, string, Map or Set iterator (object kind 13; ECMA-262 23.1.5, 22.1.5, 24.1.5, 24.2.6). */
typedef struct {
  yk src;       /* what it iterates: an array or array-like, a string, a Map, a Set; 0 when done */
  uint32_t i;   /* the next index (a string's: the next code unit) */
  int32_t mode; /* 0 keys, 1 values, 2 entries */
  int32_t type; /* 0 array, 1 string, 2 Map, 3 Set */
} builtin_iter;
static yk builtin_iter_new(yk src, int mode, int type) {
  yk r = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(r);
  builtin_iter *b = alloc(sizeof(builtin_iter));
  b->src = src, b->i = 0, b->mode = mode, b->type = type;
  o->kind = 13;
  o->ext = b;
  return r;
}
static int is_builtin_iter(yk v) { return is_object(v) && ((yk_object *)PTR(v))->kind == 13; }
/* The iterator's next value, or 0 when it is done (and stays done). */
static int builtin_iter_step(yk v, yk *out) {
  builtin_iter *b = ((yk_object *)PTR(v))->ext;
  if (b->src == 0) return 0;
  uint32_t i = b->i;
  if (b->type == 1) {
    yk_string *s = str(b->src);
    if (i >= s->len) return b->src = 0, 0;
    uint32_t n = s->units[i] >= 0xD800 && s->units[i] <= 0xDBFF && i + 1 < s->len && s->units[i + 1] >= 0xDC00 &&
                 s->units[i + 1] <= 0xDFFF ? 2 : 1;
    yk_string *c = new_string(n);
    memcpy(c->units, s->units + i, n * 2);
    b->i += n;
    return *out = BOX(T_STRING, c), 1;
  }
  if (b->type >= 2) {
    yk_array *e = ((yk_object *)PTR(b->src))->entries;
    if (i >= e->len) return b->src = 0, 0;
    b->i++;
    yk item = e->items[i];
    if (b->type == 3) {
      yk pair[2] = {item, item};
      return *out = b->mode == 2 ? yk_array_of(2, pair) : item, 1;
    }
    return *out = b->mode == 2 ? yk_array_of(2, arr(item)->items) : arr(item)->items[b->mode == 0 ? 0 : 1], 1;
  }
  double len = is_array(b->src) ? arr(b->src)->len : to_number(yk_get(b->src, ascii("length")));
  if (!(i < len)) return b->src = 0, 0;
  b->i++;
  yk value = b->mode == 0 ? YK_UNDEFINED
             : is_array(b->src) ? arr(b->src)->items[i] : yk_get(b->src, to_string(yk_number(i)));
  if (b->mode == 0) return *out = yk_number(i), 1;
  if (b->mode == 1) return *out = value, 1;
  yk pair[2] = {yk_number(i), value};
  return *out = yk_array_of(2, pair), 1;
}
static yk iter_result(yk value, int done);
static yk method_thunk_code(void *c, yk self, uint64_t argc, const yk *argv) {
  yk key = ((yk_closure *)c)->captures[0];
  int which = (int)num(((yk_closure *)c)->captures[1]);
  /* %IteratorPrototype%[Symbol.iterator], %AsyncIteratorPrototype%[Symbol.asyncIterator]: this. */
  if (which == I_ITERATOR || which == I_ASYNC_ITERATOR) return self;
  /* Symbol.prototype[Symbol.toPrimitive]: thisSymbolValue. */
  if (which == I_SYMBOL && key == well_known_symbol(10)) {
    if (!is_symbol(self)) type_error("Symbol.prototype [ @@toPrimitive ] requires that 'this' be a Symbol");
    return self;
  }
  /* Function.prototype[Symbol.hasInstance]: OrdinaryHasInstance (its prototype along the value's chain). */
  if (which == I_FUNCTION && key == well_known_symbol(1)) {
    yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
    if (!is_closure(self) || !(is_object(v) || is_closure(v) || is_array(v))) return YK_FALSE;
    yk proto = yk_get(self, ascii("prototype"));
    if (!is_object(proto)) type_error("Function has non-object prototype in instanceof check");
    for (yk p = prototype_of(v); is_object(p); p = prototype_of(p))
      if (p == proto) return YK_TRUE;
    return YK_FALSE;
  }
  /* RegExp.prototype[Symbol.replace] and its kin: the string method with this RegExp. */
  if (which == I_REGEXP && is_symbol(key))
    for (int w = 4; w <= 9; w++)
      if (key == well_known_symbol(w)) {
        yk subject = to_string(argc > 0 ? argv[0] : YK_UNDEFINED);
        yk args[3] = {self, argc > 1 ? argv[1] : YK_UNDEFINED, argc > 2 ? argv[2] : YK_UNDEFINED};
        return call_method_key(subject, ascii(well_known_names[w]), argc > 1 ? (argc > 2 ? 3 : 2) : 1, args);
      }
  /* String.prototype[Symbol.iterator] on any value (String.prototype itself among them): its string's. */
  if (which == I_STRING && key == symbol_iterator() && !is_string(self)) {
    if (is_nullish(self)) type_error("String.prototype[Symbol.iterator] called on null or undefined");
    return builtin_iter_new(self == intrinsic_proto(I_STRING) ? ascii("") : to_string(self), 1, 1);
  }
  /* Array.prototype's iterators on any array-like. */
  if (which == I_ARRAY && !is_array(self) && !is_object(self) && !is_closure(self) && is_nullish(self))
    type_error("Cannot convert undefined or null to object");
  if (which == I_ARRAY && !is_array(self) && (key_is(key, "keys") || key_is(key, "values") || key_is(key, "entries") ||
                                             key == symbol_iterator()))
    return builtin_iter_new(self, key_is(key, "keys") ? 0 : key_is(key, "entries") ? 2 : 1, 0);
  if (is_object(self) && (((yk_object *)PTR(self))->kind == 1 || ((yk_object *)PTR(self))->kind == 2)) {
    /* Map.prototype.set and the like on a Map: its own semantics, not a subclass's override. */
    yk out;
    if (collection_method((yk_object *)PTR(self), self, ((yk_closure *)c)->captures[0], argc, argv, &out)) return out;
  }
  if (is_object(self) && ((yk_object *)PTR(self))->kind >= 6 && ((yk_object *)PTR(self))->kind <= 8) {
    /* TypedArray.prototype.slice and the like on a Buffer: the built-in's, not Buffer's own. */
    yk out;
    if (buffer_method(self, ((yk_closure *)c)->captures[0], argc, argv, &out)) return out;
  }
  return call_method_key(self, ((yk_closure *)c)->captures[0], argc, argv);
}
/* Object.prototype's own methods: its semantics on any receiver (not the receiver's type's). */
static yk object_thunk_code(void *c, yk self, uint64_t argc, const yk *argv) {
  yk key = ((yk_closure *)c)->captures[0];
  yk arg0 = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (key_is(key, "toString")) return object_to_string(self);
  if (key_is(key, "toLocaleString")) return call_method_key(self, ascii("toString"), 0, NULL);
  if (key_is(key, "valueOf")) return self;
  if (key_is(key, "hasOwnProperty") || key_is(key, "propertyIsEnumerable")) return yk_bool(has_own(self, arg0));
  return call_method_key(self, key, argc, argv);
}
static yk native_getter(yk self, yk key);
static yk getter_thunk_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)argc, (void)argv;
  return native_getter(self, ((yk_closure *)c)->captures[0]);
}
static yk intrinsic_proto(int which) {
  if (intrinsic_protos[which] != 0) return intrinsic_protos[which];
  yk p = yk_object_of(0, NULL, NULL);
  intrinsic_protos[which] = p;
  yk_object *o = (yk_object *)PTR(p);
  o->proto = which == I_OBJECT                ? YK_NULL
             : which >= I_TA_BASE             ? intrinsic_proto(I_TYPED_ARRAY)
             : which >= I_TYPED_ARRAY         ? intrinsic_proto(I_OBJECT)
             : which == I_ASYNC_GENERATOR     ? intrinsic_proto(I_ASYNC_ITERATOR)
             : which == I_ASYNC_ITERATOR      ? intrinsic_proto(I_OBJECT)
             : which >= I_ASYNC_FUNCTION      ? intrinsic_proto(I_FUNCTION)
             : which > I_ITERATOR             ? intrinsic_proto(I_ITERATOR)
                                              : intrinsic_proto(I_OBJECT);
  for (const char *const *m = intrinsic_table[which].methods; *m != NULL; m++) {
    yk key = ascii(*m);
    yk caps[2] = {key, yk_number(which)};
    yk f = named(yk_closure_new(which == I_OBJECT ? object_thunk_code : method_thunk_code, 1, 2, caps), key);
    ((yk_closure *)PTR(f))->flen = method_length(intrinsic_table[which].name, *m);
    own_set(o, key, f);
  }
  for (const char *const *g = intrinsic_table[which].getters; *g != NULL; g++) {
    yk key = ascii(*g);
    define_accessor(o, key, yk_closure_new(getter_thunk_code, 1, 1, &key), 0);
  }
  /* The iterator method each iterable type has. */
  if (which == I_ARRAY || which == I_SET) own_set(o, symbol_iterator(), yk_get(p, ascii("values")));
  if (which == I_MAP) own_set(o, symbol_iterator(), yk_get(p, ascii("entries")));
  if ((which > I_ITERATOR && which != I_ASYNC_ITERATOR && which != I_TYPED_ARRAY && which < I_TA_BASE) || (which >= I_MAP && which <= I_PROMISE) || (which >= I_WEAKMAP && which <= I_FINREG) ||
      which == I_SYMBOL || which == I_BIGINT)
    own_set(o, well_known_symbol(11), ascii(intrinsic_table[which].name));
  if (which == I_TYPED_ARRAY) {
    /* %TypedArray.prototype%: [Symbol.iterator] is values; [Symbol.toStringTag] a getter (the type's
       name on a typed array, undefined on anything else). */
    own_set(o, symbol_iterator(), yk_get(p, ascii("values")));
    yk tag = well_known_symbol(11);
    define_accessor(o, tag, yk_closure_new(getter_thunk_code, 1, 1, &tag), 0);
  }
  if (which >= I_TA_BASE) own_set(o, ascii("BYTES_PER_ELEMENT"), yk_number(ta_bytes(which - I_TA_BASE)));
  if (which == I_GENERATOR_FUNCTION || which == I_ASYNC_GENERATOR_FUNCTION) {
    /* %GeneratorFunction.prototype%.prototype: %GeneratorPrototype%, whose constructor it is. */
    yk g = intrinsic_proto(which == I_GENERATOR_FUNCTION ? I_GENERATOR : I_ASYNC_GENERATOR);
    own_set(o, ascii("prototype"), g);
    own_set((yk_object *)PTR(g), ascii("constructor"), p);
  }
  if (which == I_SYMBOL) {
    yk key = well_known_symbol(10), caps[2] = {key, yk_number(which)};
    own_set(o, key, named(yk_closure_new(method_thunk_code, 1, 2, caps), ascii("[Symbol.toPrimitive]")));
  }
  if (which == I_FUNCTION) {
    yk key = well_known_symbol(1), caps[2] = {key, yk_number(which)};
    own_set(o, key, named(yk_closure_new(method_thunk_code, 1, 2, caps), ascii("[Symbol.hasInstance]")));
  }
  if (which == I_REGEXP)
    for (int w = 4; w <= 9; w++) {
      if (w == 8) continue; /* species is a constructor's */
      yk key = well_known_symbol(w), caps[2] = {key, yk_number(which)};
      char nm[32];
      snprintf(nm, sizeof nm, "[Symbol.%s]", well_known_names[w]);
      own_set(o, key, named(yk_closure_new(method_thunk_code, 1, 2, caps), ascii(nm)));
    }
  if (which == I_ASYNC_ITERATOR) {
    yk key = symbol_async_iterator();
    yk caps[2] = {key, yk_number(which)};
    own_set(o, key, named(yk_closure_new(method_thunk_code, 1, 2, caps), ascii("[Symbol.asyncIterator]")));
  }
  if (which == I_STRING || which == I_ITERATOR) {
    yk key = symbol_iterator();
    yk caps[2] = {key, yk_number(which)};
    own_set(o, key, named(yk_closure_new(method_thunk_code, 1, 2, caps), ascii("[Symbol.iterator]")));
  }
  return p;
}
/* A function's intrinsic prototype: %AsyncFunction.prototype%, %GeneratorFunction.prototype%,
   %AsyncGeneratorFunction.prototype%, or Function.prototype. */
static yk closure_proto(yk_closure *c) {
  return intrinsic_proto(c->mode == 1 ? I_ASYNC_FUNCTION : c->mode == 2 ? I_GENERATOR_FUNCTION
                         : c->mode == 3 ? I_ASYNC_GENERATOR_FUNCTION : I_FUNCTION);
}
static yk generator_proto(int async) { return intrinsic_proto(async ? I_ASYNC_GENERATOR : I_GENERATOR); }
/* The intrinsic prototype a value's own chain ends in, or 0 (an object whose chain ends in null). */
static yk tail_proto(yk v) {
  if (is_object(v)) {
    yk x = v;
    while (is_object(((yk_object *)PTR(x))->proto)) x = ((yk_object *)PTR(x))->proto;
    yk_object *o = (yk_object *)PTR(x);
    if (o->proto == YK_NULL) return 0;
    switch (o->kind) {
    case 1: return intrinsic_proto(I_MAP);
    case 2: return intrinsic_proto(I_SET);
    case 3: return intrinsic_proto(I_REGEXP);
    case 4: return intrinsic_proto(I_PROMISE);
    case 10: return intrinsic_proto(I_DATE);
    case 11: return intrinsic_proto(I_WEAKREF);
    case 12: return intrinsic_proto(I_FINREG);
    case 6: return intrinsic_proto(I_ARRAY_BUFFER);
    case 7: return intrinsic_proto(I_TA_BASE + view_type(x));
    case 8: return intrinsic_proto(I_DATA_VIEW);
    case 13: return intrinsic_proto(I_ARRAY_ITERATOR + ((builtin_iter *)o->ext)->type);
    default: return intrinsic_proto(o->error ? I_ERROR : I_OBJECT);
    }
  }
  if (is_closure(v)) return closure_proto((yk_closure *)PTR(v));
  if (is_array(v)) return intrinsic_proto(I_ARRAY);
  if (is_string(v)) return intrinsic_proto(I_STRING);
  if (is_number(v)) return intrinsic_proto(I_NUMBER);
  if (is_bool(v)) return intrinsic_proto(I_BOOLEAN);
  if (is_symbol(v)) return intrinsic_proto(I_SYMBOL);
  if (is_bigint(v)) return intrinsic_proto(I_BIGINT);
  return 0;
}
/* A property a value's own chain lacks, from its type's intrinsic prototype (a getter called with
   the value as its receiver); undefined if none has it. */
static yk proto_lookup(yk v, yk key) {
  yk p = tail_proto(v), slot;
  if (p == 0 || !chain_get(p, to_property_key(key), &slot)) return YK_UNDEFINED;
  return resolve_slot(slot, v);
}

/* An intrinsic getter's value on its receiver: the runtime's own (Map/Set size, a symbol's
   description, a RegExp's source and flags); a TypeError on a receiver of another type. */
static yk native_getter(yk self, yk key) {
  if (is_symbol(self) && key_is(key, "description")) return ((yk_symbol *)PTR(self))->description;
  if (is_object(self)) {
    yk_object *o = (yk_object *)PTR(self);
    if ((o->kind == 1 || o->kind == 2) && key_is(key, "size")) return yk_number(o->entries->len);
    if (o->kind == 3) return yk_get(self, key); /* RegExp: its own branch reads source and flags */
    if (o->kind >= 6 && o->kind <= 8) {
      if (key == well_known_symbol(11)) return o->kind == 7 ? ascii(ta_name(view_type(self))) : YK_UNDEFINED;
      yk got;
      if (o->kind == 6 && key_is(key, "maxByteLength")) return yk_get(self, ascii("byteLength"));
      if (o->kind == 6 && (key_is(key, "resizable") || key_is(key, "detached"))) return YK_FALSE;
      if (buffer_get(self, key, &got)) return got;
    }
  }
  if (key == well_known_symbol(11)) return YK_UNDEFINED; /* %TypedArray.prototype%'s tag on a non-view */
  type_error("Method called on an incompatible receiver");
  return YK_UNDEFINED;
}
/* key in a value's own properties (Object.prototype.hasOwnProperty). */
static int has_own(yk v, yk key) {
  key = to_property_key(key);
  yk slot;
  if (is_object(v)) return own_get((yk_object *)PTR(v), key, &slot);
  if (is_closure(v)) {
    yk_closure *c = (yk_closure *)PTR(v);
    if (is_string(key) && (key_is(key, "name") || key_is(key, "length"))) return 1;
    /* A function's prototype exists from its first use (made then). */
    if (is_string(key) && key_is(key, "prototype") && (c->has_this || c->is_class || c->mode == 2 || c->mode == 3))
      return ensure_prototype(v), 1;
    return c->props != 0 && own_get((yk_object *)PTR(c->props), key, &slot);
  }
  if (is_array(v)) {
    yk_array *a = arr(v);
    if (key_is(key, "length")) return 1;
    int64_t i = index_of_key(key);
    if (i >= 0) return i < a->len && !array_hole(a, (uint32_t)i);
    return a->props != 0 && own_get((yk_object *)PTR(a->props), key, &slot);
  }
  if (is_string(v)) {
    if (key_is(key, "length")) return 1;
    int64_t i = index_of_key(key);
    return i >= 0 && i < str(v)->len;
  }
  return 0;
}
/* Object.prototype.toString: "[object " + the tag + "]" (Symbol.toStringTag when it is a string). */
static yk object_to_string(yk v) {
  const char *tag = "Object";
  if (v == YK_UNDEFINED) tag = "Undefined";
  else if (v == YK_NULL) tag = "Null";
  else if (is_array(v)) tag = "Array";
  else if (is_closure(v)) tag = "Function";
  else if (is_string(v)) tag = "String";
  else if (is_number(v)) tag = "Number";
  else if (is_bool(v)) tag = "Boolean";
  else if (is_symbol(v)) tag = "Symbol";
  else if (is_bigint(v)) tag = "BigInt";
  else if (is_object(v)) {
    yk_object *o = (yk_object *)PTR(v);
    if (o->error) tag = "Error";
    else if (o->kind == 3) tag = "RegExp";
  }
  if (is_object(v) || is_closure(v)) {
    yk t = yk_get(v, well_known_symbol(11));
    if (is_string(t)) return concat(str(concat(str(ascii("[object ")), str(t))), str(ascii("]")));
  }
  char buf[40];
  snprintf(buf, sizeof buf, "[object %s]", tag);
  return ascii(buf);
}

/* --- reflection (#1331): Reflect, Object's reflective functions, Function, globalThis --- */
static yk_array *own_keys_of(yk v);
static yk_array *ordered_keys(yk_object *o);
static yk_array *symbol_keys(yk_object *o);
yk yk_in(yk key, yk obj);
yk yk_new(yk f, uint64_t argc, const yk *argv);
static yk with_methods(yk_code code, int n, const char *const *names, const yk_code *codes);
static yk arg_or_undefined(uint64_t argc, const yk *argv, uint64_t i) { return i < argc ? argv[i] : YK_UNDEFINED; }
/* [[GetPrototypeOf]]: an object's prototype (its intrinsic one when it has none of its own). */
static yk prototype_of(yk v) {
  if (is_object(v)) {
    yk p = ((yk_object *)PTR(v))->proto;
    if (is_object(p)) return p;
    if (p == YK_NULL) return YK_NULL;
    yk t = tail_proto(v);
    return t == 0 ? YK_NULL : t;
  }
  if (is_closure(v)) {
    yk_closure *c = (yk_closure *)PTR(v);
    if (c->parent != 0 && is_closure(c->parent)) return c->parent;
    return closure_proto(c);
  }
  yk t = tail_proto(v);
  return t == 0 ? YK_NULL : t;
}
static yk reflect_get_prototype_of(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = arg_or_undefined(argc, argv, 0);
  if (is_nullish(v)) type_error("Cannot convert undefined or null to object");
  return prototype_of(v);
}
static yk reflect_set_prototype_of(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = arg_or_undefined(argc, argv, 0), p = arg_or_undefined(argc, argv, 1);
  if (is_object(v) && (is_object(p) || p == YK_NULL)) ((yk_object *)PTR(v))->proto = p;
  else if (is_closure(v) && is_closure(p)) ((yk_closure *)PTR(v))->parent = p;
  return v;
}
/* OwnPropertyKeys: its own string keys (integer indexes first), then its symbols. */
static yk_array *own_keys_of(yk v) {
  yk_array *r = new_array(4);
  if (is_array(v)) {
    for (uint32_t i = 0; i < arr(v)->len; i++)
      if (!array_hole(arr(v), i)) push(r, to_string(yk_number(i)));
    push(r, ascii("length"));
    v = arr(v)->props;
    if (v == 0) return r;
  } else if (is_string(v)) {
    for (uint32_t i = 0; i < str(v)->len; i++) push(r, to_string(yk_number(i)));
    push(r, ascii("length"));
    return r;
  } else if (is_closure(v)) {
    yk_closure *c = (yk_closure *)PTR(v);
    yk p;
    int named_own = c->props != 0 && own_get((yk_object *)PTR(c->props), ascii("name"), &p);
    int length_own = c->props != 0 && own_get((yk_object *)PTR(c->props), ascii("length"), &p);
    if (!length_own) push(r, ascii("length"));
    if (!named_own) push(r, ascii("name"));
    v = c->props;
    if (v == 0) return r;
  }
  if (!is_object(v)) return r;
  yk_array *s = ordered_keys((yk_object *)PTR(v));
  for (uint32_t i = 0; i < s->len; i++) push(r, s->items[i]);
  s = symbol_keys((yk_object *)PTR(v));
  for (uint32_t i = 0; i < s->len; i++) push(r, s->items[i]);
  return r;
}
static yk reflect_own_keys(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return BOX(T_ARRAY, own_keys_of(arg_or_undefined(argc, argv, 0)));
}
static yk object_get_own_property_names(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_array *k = own_keys_of(arg_or_undefined(argc, argv, 0)), *r = new_array(k->len);
  for (uint32_t i = 0; i < k->len; i++)
    if (is_string(k->items[i])) push(r, k->items[i]);
  return BOX(T_ARRAY, r);
}
static yk object_get_own_property_symbols(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_array *k = own_keys_of(arg_or_undefined(argc, argv, 0)), *r = new_array(2);
  for (uint32_t i = 0; i < k->len; i++)
    if (is_symbol(k->items[i])) push(r, k->items[i]);
  return BOX(T_ARRAY, r);
}
/* The own slot of a key: an object's (or a function's, an array's extra) properties. */
static int own_slot(yk v, yk key, yk *slot) {
  if (is_object(v)) return own_get((yk_object *)PTR(v), key, slot);
  if (is_closure(v)) {
    yk p = ((yk_closure *)PTR(v))->props;
    return p != 0 && own_get((yk_object *)PTR(p), key, slot);
  }
  if (is_array(v) && arr(v)->props != 0) return own_get((yk_object *)PTR(arr(v)->props), key, slot);
  return 0;
}
/* [[GetOwnProperty]] as a descriptor object, or undefined. Every property is writable, enumerable
   and configurable here: the runtime keeps no attributes. */
static yk descriptor_of(yk v, yk key) {
  key = to_property_key(key);
  if (!has_own(v, key)) return YK_UNDEFINED;
  yk slot, t = YK_TRUE;
  if (own_slot(v, key, &slot) && is_accessor(slot)) {
    yk_accessor *a = (yk_accessor *)PTR(slot);
    yk keys[4] = {ascii("get"), ascii("set"), ascii("enumerable"), ascii("configurable")};
    yk vals[4] = {a->get != 0 ? a->get : YK_UNDEFINED, a->set != 0 ? a->set : YK_UNDEFINED, t, t};
    if ((is_object(v) || is_closure(v)) && is_hidden(own_props(v), key)) vals[2] = YK_FALSE;
    return yk_object_of(4, keys, vals);
  }
  yk keys[4] = {ascii("value"), ascii("writable"), ascii("enumerable"), ascii("configurable")};
  yk vals[4] = {yk_get(v, key), t, t, t};
  if ((is_object(v) || is_closure(v)) && is_hidden(own_props(v), key)) vals[2] = YK_FALSE;
  /* The non-enumerable own properties the runtime makes: an array's length; a function's name and
     length (read-only, configurable) and prototype (writable, not configurable). */
  if (is_array(v) && key_is(key, "length")) vals[2] = YK_FALSE, vals[3] = YK_FALSE;
  if (is_closure(v) && (key_is(key, "name") || key_is(key, "length")) && !own_slot(v, key, &slot))
    vals[1] = YK_FALSE, vals[2] = YK_FALSE;
  if (is_closure(v) && key_is(key, "prototype")) vals[2] = YK_FALSE, vals[3] = YK_FALSE;
  return yk_object_of(4, keys, vals);
}
static yk reflect_get_own_property_descriptor(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return descriptor_of(arg_or_undefined(argc, argv, 0), arg_or_undefined(argc, argv, 1));
}
static yk object_get_own_property_descriptors(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = arg_or_undefined(argc, argv, 0), r = yk_object_of(0, NULL, NULL);
  yk_array *k = own_keys_of(v);
  for (uint32_t i = 0; i < k->len; i++) own_set((yk_object *)PTR(r), k->items[i], descriptor_of(v, k->items[i]));
  return r;
}
/* [[DefineOwnProperty]] from a descriptor: an accessor's get/set, or a value. */
static void define_from(yk v, yk key, yk desc) {
  key = to_property_key(key);
  if (!is_object(desc) && !is_closure(desc)) type_error("Property description must be an object");
  /* Its enumerability: the descriptor's when it says, else a new property's is false (an existing
     one keeps its own). */
  int existed = has_own(v, key);
  int says = yk_in(ascii("enumerable"), desc) == YK_TRUE;
  int enumerable = says ? yk_truthy(yk_get(desc, ascii("enumerable"))) : 0;
  if (is_object(v) || is_closure(v)) {
    yk_object *o = own_props(v);
    if (says) set_hidden(o, key, !enumerable);
    else if (!existed) set_hidden(o, key, 1);
  }
  yk g = yk_get(desc, ascii("get")), st = yk_get(desc, ascii("set"));
  if (g != YK_UNDEFINED || st != YK_UNDEFINED) {
    yk_object *o = is_array(v) ? (arr(v)->props == 0 ? (yk_object *)PTR(arr(v)->props = yk_object_of(0, NULL, NULL))
                                                     : (yk_object *)PTR(arr(v)->props))
                               : own_props(v);
    define_accessor(o, key, is_closure(g) ? g : 0, is_closure(st) ? st : 0);
    return;
  }
  if (yk_in(ascii("value"), desc) == YK_TRUE) {
    yk value = yk_get(desc, ascii("value"));
    if (is_object(v) || is_closure(v)) own_set(own_props(v), key, value);
    else yk_set(v, key, value);
  } else if (!has_own(v, key) && (is_object(v) || is_closure(v)))
    own_set(own_props(v), key, YK_UNDEFINED);
}
static yk object_define_property(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = arg_or_undefined(argc, argv, 0);
  if (!is_object(v) && !is_closure(v) && !is_array(v)) type_error("Object.defineProperty called on non-object");
  define_from(v, arg_or_undefined(argc, argv, 1), arg_or_undefined(argc, argv, 2));
  return v;
}
static yk reflect_define_property(void *c, yk s, uint64_t argc, const yk *argv) {
  object_define_property(c, s, argc, argv);
  return YK_TRUE;
}
static yk object_define_properties(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = arg_or_undefined(argc, argv, 0), props = arg_or_undefined(argc, argv, 1);
  yk_array *k = own_keys_of(props);
  for (uint32_t i = 0; i < k->len; i++) define_from(v, k->items[i], yk_get(props, k->items[i]));
  return v;
}
static yk object_create(void *c, yk s, uint64_t argc, const yk *argv) {
  yk o = yk_object_of(0, NULL, NULL), p = arg_or_undefined(argc, argv, 0);
  if (!is_object(p) && p != YK_NULL) type_error("Object prototype may only be an Object or null");
  ((yk_object *)PTR(o))->proto = p;
  if (argc > 1 && argv[1] != YK_UNDEFINED) object_define_properties(c, s, 2, (yk[]){o, argv[1]});
  return o;
}
static yk object_has_own(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return yk_bool(has_own(arg_or_undefined(argc, argv, 0), arg_or_undefined(argc, argv, 1)));
}
static yk object_from_entries(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk o = yk_object_of(0, NULL, NULL);
  yk_array *items = iterable_items(arg_or_undefined(argc, argv, 0));
  for (uint32_t i = 0; i < items->len; i++)
    own_set((yk_object *)PTR(o), to_property_key(yk_get(items->items[i], yk_number(0))), yk_get(items->items[i], yk_number(1)));
  return o;
}
static yk object_false(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s, (void)argc, (void)argv; return YK_FALSE; }
static yk object_true(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s, (void)argc, (void)argv; return YK_TRUE; }
static yk object_first(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return arg_or_undefined(argc, argv, 0); }
static yk reflect_apply(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk args = arg_or_undefined(argc, argv, 2);
  return call_method_key(arg_or_undefined(argc, argv, 0), ascii("apply"), 2, (yk[]){arg_or_undefined(argc, argv, 1), args});
}
static yk reflect_construct(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_array *args = iterable_items(arg_or_undefined(argc, argv, 1));
  return yk_new(arg_or_undefined(argc, argv, 0), args->len, args->items);
}
static yk reflect_get(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return yk_get(arg_or_undefined(argc, argv, 0), arg_or_undefined(argc, argv, 1));
}
static yk reflect_set(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_set(arg_or_undefined(argc, argv, 0), arg_or_undefined(argc, argv, 1), arg_or_undefined(argc, argv, 2));
  return YK_TRUE;
}
static yk reflect_has(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = arg_or_undefined(argc, argv, 0), k = arg_or_undefined(argc, argv, 1);
  if (has_own(v, k)) return YK_TRUE;
  return yk_bool(proto_lookup(v, k) != YK_UNDEFINED || yk_in(k, v) == YK_TRUE);
}
static yk reflect_delete_property(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return yk_delete(arg_or_undefined(argc, argv, 0), arg_or_undefined(argc, argv, 1));
}
static yk reflect_global(void) {
  static yk r = 0;
  if (r != 0) return r;
  static const char *const m[13] = {"apply", "construct", "defineProperty", "deleteProperty", "get",
                                    "getOwnPropertyDescriptor", "getPrototypeOf", "has", "isExtensible",
                                    "ownKeys", "preventExtensions", "set", "setPrototypeOf"};
  static const yk_code k[13] = {reflect_apply, reflect_construct, reflect_define_property, reflect_delete_property,
                                reflect_get, reflect_get_own_property_descriptor, reflect_get_prototype_of,
                                reflect_has, object_true, reflect_own_keys, object_true, reflect_set,
                                reflect_set_prototype_of};
  return r = with_methods(NULL, 13, m, k);
}
/* Function: no code is compiled at run time here; its prototype is the intrinsic one. */
static yk builtin_function(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s, (void)argc, (void)argv;
  type_error("Function() compiles code at run time, which the native runtime does not");
  return YK_UNDEFINED;
}
static yk function_global(void) {
  static yk f = 0;
  if (f != 0) return f;
  f = yk_closure_new(builtin_function, 0, 0, NULL);
  yk p = intrinsic_proto(I_FUNCTION);
  own_set(own_props(f), ascii("prototype"), p);
  own_set((yk_object *)PTR(p), ascii("constructor"), f);
  return f;
}
/* globalThis: an object of the globals, each made when first read. */
static yk global_this(void) {
  static yk g = 0;
  if (g != 0) return g;
  g = yk_object_of(0, NULL, NULL);
  static const char *const names[] = {"Object", "Function", "Array", "String", "Number", "Boolean", "Symbol",
                                      "BigInt", "Map", "Set", "Promise", "Error", "TypeError", "RangeError",
                                      "SyntaxError", "JSON", "Reflect", "parseInt", "parseFloat", "isNaN",
                                      "isFinite", "queueMicrotask", "ArrayBuffer", "DataView", "Uint8Array",
                                      "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array",
                                      "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
                                      "Uint8ClampedArray", "TextEncoder", "console", "process", "EvalError",
                                      "ReferenceError", "URIError", "AggregateError", "WeakMap", "WeakSet",
                                      "WeakRef", "FinalizationRegistry", "Date", "RegExp", "encodeURIComponent",
                                      "encodeURI", "decodeURIComponent", "decodeURI", "escape", "unescape",
                                      "eval", NULL};
  for (int i = 0; names[i] != NULL; i++) {
    yk v = yk_global(names[i], strlen(names[i]));
    if (v != YK_UNDEFINED) own_set((yk_object *)PTR(g), ascii(names[i]), v);
  }
  own_set((yk_object *)PTR(g), ascii("globalThis"), g);
  own_set((yk_object *)PTR(g), ascii("NaN"), yk_number(NAN));
  own_set((yk_object *)PTR(g), ascii("Infinity"), yk_number(INFINITY));
  own_set((yk_object *)PTR(g), ascii("undefined"), YK_UNDEFINED);
  return g;
}

/* --- keys, in the order JavaScript gives them: array indexes ascending, then strings as added --- */

static int canonical_index(yk_string *s, uint32_t *out) {
  if (s->len == 0 || s->len > 10 || (s->len > 1 && s->units[0] == '0')) return 0;
  double d = 0;
  for (uint32_t i = 0; i < s->len; i++) {
    if (s->units[i] < '0' || s->units[i] > '9') return 0;
    d = d * 10 + (s->units[i] - '0');
  }
  if (d > 4294967294.0) return 0;
  *out = (uint32_t)d;
  return 1;
}

/* An object's own symbol keys, in the order they were added. */
static yk_array *symbol_keys(yk_object *o) {
  yk_array *r = new_array(2);
  for (uint32_t i = 0; i < o->len; i++)
    if (is_symbol(o->keys[i])) push(r, o->keys[i]);
  return r;
}
/* An object's own string keys, in OrdinaryOwnPropertyKeys' order: integer indexes ascending, then the
   others as they were added. */
/* Whether an object's own key is not enumerable (defined so). */
static int key_equal(yk a, yk b);
static int is_hidden(yk_object *o, yk key) {
  if (o->hidden == NULL) return 0;
  for (uint32_t i = 0; i < o->hidden->len; i++)
    if (key_equal(o->hidden->items[i], key)) return 1;
  return 0;
}
static void push(yk_array *a, yk v);
static void set_hidden(yk_object *o, yk key, int hidden) {
  if (hidden == is_hidden(o, key)) return;
  if (hidden) {
    if (o->hidden == NULL) o->hidden = new_array(2);
    push(o->hidden, key);
    return;
  }
  yk_array *h = o->hidden;
  for (uint32_t i = 0; i < h->len; i++)
    if (key_equal(h->items[i], key)) {
      h->items[i] = h->items[h->len - 1];
      h->len--;
      return;
    }
}
static yk_array *ordered_keys(yk_object *o);
/* An object's enumerable own string keys, in order (Object.keys, for…in, JSON, spread). */
static yk_array *enumerable_keys(yk_object *o) {
  yk_array *k = ordered_keys(o);
  if (o->hidden == NULL || o->hidden->len == 0) return k;
  yk_array *r = new_array(k->len);
  for (uint32_t i = 0; i < k->len; i++)
    if (!is_hidden(o, k->items[i])) push(r, k->items[i]);
  return r;
}
static yk_array *ordered_keys(yk_object *o) {
  yk_array *r = new_array(o->len);
  uint32_t *idx = scratch((size_t)o->len * sizeof(uint32_t) + 4);
  yk *ik = alloc((size_t)o->len * sizeof(yk) + 8);
  uint32_t n = 0;
  for (uint32_t i = 0; i < o->len; i++) {
    uint32_t k;
    if (!is_string(o->keys[i])) continue; /* a symbol: not a string key */
    if (canonical_index(str(o->keys[i]), &k)) {
      uint32_t j = n++;
      while (j > 0 && idx[j - 1] > k) idx[j] = idx[j - 1], ik[j] = ik[j - 1], j--;
      idx[j] = k;
      ik[j] = o->keys[i];
    }
  }
  for (uint32_t i = 0; i < n; i++) push(r, ik[i]);
  for (uint32_t i = 0; i < o->len; i++) {
    uint32_t k;
    if (is_string(o->keys[i]) && !canonical_index(str(o->keys[i]), &k)) push(r, o->keys[i]);
  }
  free(idx);
  return r;
}

/* --- iteration: for…of over arrays (live) and strings (by code point); for…in over keys --- */

typedef struct {
  int32_t internal; /* 1: an iterator */
  yk src;
  uint32_t i;
  yk_array *keys; /* for…in: the keys, taken when the loop starts */
  yk gen;         /* for…of over a generator: the generator, or 0 */
  int32_t awaits; /* for await…of: each next() result (an async generator's) or element awaited */
  yk agen;        /* for await…of over an async generator: it, or 0 */
  yk proto;       /* an iterator by the protocol (an object's [Symbol.iterator]()), or 0 */
  yk next;        /* its next method */
  int32_t proto_async; /* the iterator is an async one ([Symbol.asyncIterator]): next() awaited */
  int32_t finished;    /* it said done (or threw): not closed again */
  yk biter;            /* a built-in iterator (kind 13), or 0 */
} yk_iter;
/* An object's (or function's) iterator method by the protocol, or 0: [Symbol.asyncIterator] first
   when asked for an async one, then [Symbol.iterator]. */
static yk protocol_method(yk v, int async, int *is_async) {
  if (!((is_object(v) && ((yk_object *)PTR(v))->kind == 0) || is_closure(v))) return 0;
  yk m;
  if (async) {
    m = yk_get(v, symbol_async_iterator());
    if (is_closure(m)) return *is_async = 1, m;
  }
  m = yk_get(v, symbol_iterator());
  if (is_closure(m)) return *is_async = 0, m;
  return 0;
}
static yk protocol_start(yk_iter *it, yk v, yk method, int is_async) {
  yk iter = call_value(method, v, 0, NULL);
  if (!is_object(iter) && !is_closure(iter)) type_error("the iterator is not an object");
  it->proto = iter;
  it->next = yk_get(iter, ascii("next"));
  it->proto_async = is_async;
  return BOX(T_INTERNAL, it);
}
static yk agen_request(yk self, int mode, yk value);
yk yk_await(yk v);

yk yk_iter_new(yk v, int32_t keys) {
  yk_iter *it = alloc(sizeof(yk_iter));
  it->internal = 1;
  it->src = v;
  it->i = 0;
  it->keys = NULL;
  if (keys == 2) {
    /* for await…of: an async generator is drawn one awaited next() at a time; an async iterable by
       the protocol likewise; anything else is iterated as for…of, each element awaited
       (CreateAsyncFromSyncIterator). */
    it->awaits = 1;
    if (is_object(v) && ((yk_object *)PTR(v))->kind == 9) {
      it->agen = v;
      return BOX(T_INTERNAL, it);
    }
    int is_async = 0;
    yk m = protocol_method(v, 1, &is_async);
    if (m != 0) {
      if (is_async) it->awaits = 0;
      return protocol_start(it, v, m, is_async);
    }
    keys = 0;
  }
  if (!keys) {
    int is_async = 0;
    yk m = protocol_method(v, 0, &is_async);
    if (m != 0) return protocol_start(it, v, m, 0);
  }
  if (keys) {
    if (is_object(v))
      it->keys = enumerable_keys((yk_object *)PTR(v));
    else {
      it->keys = new_array(4);
      uint32_t n = is_array(v) ? arr(v)->len : is_string(v) ? str(v)->len : 0;
      for (uint32_t i = 0; i < n; i++)
        if (!(is_array(v) && array_hole(arr(v), i))) push(it->keys, to_string(yk_number(i)));
    }
  } else if (is_object(v) && ((yk_object *)PTR(v))->kind == 5) {
    it->gen = v; /* a generator: drawn from one next() at a time */
  } else if (is_builtin_iter(v)) {
    it->biter = v; /* an array's, string's, Map's or Set's iterator: drawn as it goes */
  } else if (is_object(v) && ((yk_object *)PTR(v))->kind != 0) {
    it->src = BOX(T_ARRAY, iterable_items(v));
  } else if (!is_array(v) && !is_string(v))
    type_error("the value is not iterable here");
  return BOX(T_INTERNAL, it);
}

static int iter_step(yk_iter *it, yk *out);
int yk_iter_next(yk itv, yk *out) {
  yk_iter *it = (yk_iter *)PTR(itv);
  if (it->agen != 0) {
    yk r = yk_await(agen_request(it->agen, 0, YK_UNDEFINED));
    if (yk_truthy(yk_get(r, ascii("done")))) return 0;
    *out = yk_get(r, ascii("value"));
    return 1;
  }
  if (!iter_step(it, out)) return 0;
  if (it->awaits) *out = yk_await(*out);
  return 1;
}
static int iter_step(yk_iter *it, yk *out) {
  if (it->proto != 0) {
    if (it->finished) return 0;
    yk r = call_value(it->next, it->proto, 0, NULL);
    if (it->proto_async) r = yk_await(r);
    if (!is_object(r) && !is_closure(r)) {
      it->finished = 1;
      type_error("Iterator result is not an object");
    }
    if (yk_truthy(yk_get(r, ascii("done")))) {
      it->finished = 1;
      return 0;
    }
    *out = yk_get(r, ascii("value"));
    return 1;
  }
  if (it->gen != 0) return generator_step(it->gen, out);
  if (it->biter != 0) return builtin_iter_step(it->biter, out);
  if (it->keys != NULL) {
    if (it->i >= it->keys->len) return 0;
    *out = it->keys->items[it->i++];
    return 1;
  }
  if (is_array(it->src)) {
    yk_array *a = arr(it->src);
    if (it->i >= a->len) return 0;
    *out = a->items[it->i++];
    return 1;
  }
  yk_string *s = str(it->src);
  if (it->i >= s->len) return 0;
  uint16_t u = s->units[it->i];
  uint32_t n = (u >= 0xD800 && u <= 0xDBFF && it->i + 1 < s->len && s->units[it->i + 1] >= 0xDC00 &&
                s->units[it->i + 1] <= 0xDFFF)
                   ? 2
                   : 1;
  yk_string *c = new_string(n);
  memcpy(c->units, s->units + it->i, (size_t)n * 2);
  it->i += n;
  *out = string_of(c);
  return 1;
}

/* --- functions --- */

yk yk_closure_new(yk_code code, int32_t has_this, uint64_t n, const yk *captures) {
  yk_closure *c = alloc(sizeof(yk_closure) + (size_t)n * sizeof(yk));
  c->code = code;
  c->has_this = has_this;
  c->is_class = 0;
  c->props = 0;
  c->class_self = 0;
  c->parent = 0;
  c->home_static = 0;
  c->mode = 0;
  c->fname = 0;
  c->flen = 0;
  c->n = (uint32_t)n;
  memcpy(c->captures, captures, (size_t)n * sizeof(yk));
  return BOX(T_CLOSURE, c);
}
yk yk_closure_self(void *closure) { return BOX(T_CLOSURE, closure); }
/* A function's closure with no captures, made once into *slot (an atom's, #1362). */
yk yk_closure_once(yk *slot, yk_code code) {
  if (*slot == 0) *slot = yk_closure_new(code, 0, 0, NULL);
  return *slot;
}
yk yk_capture(void *closure, uint64_t i) { return ((yk_closure *)closure)->captures[i]; }
yk yk_arg(uint64_t argc, const yk *argv, uint64_t i) { return i < argc ? argv[i] : YK_UNDEFINED; }
/* A rest parameter (...xs): the arguments from i on, as an array. */
yk yk_rest(uint64_t argc, const yk *argv, uint64_t i) { return yk_array_of(i < argc ? argc - i : 0, argv + (i < argc ? i : argc)); }

static __attribute__((noinline, cold, noreturn)) void not_callable(yk f) {
  /* V8 names the callee's expression; the runtime names the value's kind. */
  const char *what = f == YK_UNDEFINED ? "undefined" : f == YK_NULL ? "null" : is_string(f) ? "a string"
                     : is_number(f) ? "a number" : is_array(f) ? "an array" : is_object(f) ? "an object"
                     : "the value";
  char msg[64];
  snprintf(msg, sizeof msg, "%s is not a function", what);
  type_error(msg);
  __builtin_unreachable();
}
static __attribute__((noinline)) yk call_special(yk_closure *c, yk self, uint64_t argc, const yk *argv) {
  if (c->is_class) type_error("Class constructor cannot be invoked without 'new'");
  if (c->mode == 1) return async_call(c, self, argc, argv);
  if (c->mode == 2) return generator_new(c, self, argc, argv);
  return agen_new(c, self, argc, argv);
}
static yk call_value(yk f, yk self, uint64_t argc, const yk *argv) {
  if (__builtin_expect(!is_closure(f), 0)) not_callable(f);
  yk_closure *c = (yk_closure *)PTR(f);
  if (__builtin_expect(c->is_class || c->mode != 0, 0)) return call_special(c, self, argc, argv);
  return c->code(c, c->has_this ? self : YK_UNDEFINED, argc, argv);
}
yk yk_call(yk f, yk self, uint64_t argc, const yk *argv) { return call_value(f, self, argc, argv); }

/* A callback of an array builtin: (element, index, array). */
static yk callback(yk f, yk_array *a, uint32_t i, yk recv);
static void merge_sort(yk *items, yk *tmp, uint32_t n, yk cmp);
/* The rest of Array.prototype's methods (ECMA-262 23.1.3): at, concat, copyWithin, fill, findLast,
   findLastIndex, flat, flatMap, lastIndexOf, reduceRight, reverse, splice, and the copying ones
   (toReversed, toSorted, toSpliced, with). Holes read as undefined. */
static void flatten_into(yk_array *r, yk_array *src, double depth) {
  for (uint32_t i = 0; i < src->len; i++) {
    if (array_hole(src, i)) continue;
    yk e = src->items[i];
    if (depth > 0 && is_array(e)) flatten_into(r, arr(e), depth - 1);
    else push(r, e);
  }
}
static yk_array *array_copy(yk_array *a) {
  yk_array *r = new_array(a->len);
  for (uint32_t i = 0; i < a->len; i++) push(r, a->items[i]);
  return r;
}
static int64_t integer_or_infinity(yk v) {
  double d = to_number(v);
  if (d != d) return 0;
  if (d > 9e15) return INT64_MAX / 2;
  if (d < -9e15) return -(INT64_MAX / 2);
  return (int64_t)trunc(d);
}
static int array_more_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  if (!is_string(key)) return 0;
  yk_array *a = arr(recv);
  yk arg0 = argc > 0 ? argv[0] : YK_UNDEFINED, arg1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  int64_t len = a->len;
  if (key_is(key, "at")) {
    int64_t k = integer_or_infinity(arg0);
    if (k < 0) k += len;
    return *out = k < 0 || k >= len ? YK_UNDEFINED : a->items[k], 1;
  }
  if (key_is(key, "concat")) {
    yk_array *r = array_copy(a);
    for (uint64_t i = 0; i < argc; i++) {
      if (is_array(argv[i]))
        for (uint32_t j = 0; j < arr(argv[i])->len; j++) push(r, arr(argv[i])->items[j]);
      else push(r, argv[i]);
    }
    return *out = BOX(T_ARRAY, r), 1;
  }
  if (key_is(key, "copyWithin")) {
    int64_t to = relative(arg0, len, 0), from = relative(arg1, len, 0);
    int64_t fin = relative(argc > 2 ? argv[2] : YK_UNDEFINED, len, len);
    int64_t count = fin - from < len - to ? fin - from : len - to;
    if (count > 0) memmove(a->items + to, a->items + from, (size_t)count * sizeof(yk));
    a->holes = NULL, a->holes_n = 0;
    return *out = recv, 1;
  }
  if (key_is(key, "fill")) {
    int64_t k = relative(arg1, len, 0), fin = relative(argc > 2 ? argv[2] : YK_UNDEFINED, len, len);
    for (; k < fin; k++) {
      a->items[k] = arg0;
      if (a->holes != NULL) array_mark_hole(a, (uint32_t)k, 0);
    }
    return *out = recv, 1;
  }
  int find_last = key_is(key, "findLast"), find_last_index = key_is(key, "findLastIndex");
  if (find_last || find_last_index) {
    if (!is_closure(arg0)) type_error("the callback is not a function");
    for (int64_t i = len - 1; i >= 0; i--)
      if (i < a->len && yk_truthy(callback(arg0, a, (uint32_t)i, recv)))
        return *out = find_last ? a->items[i] : yk_number((double)i), 1;
    return *out = find_last ? YK_UNDEFINED : yk_number(-1), 1;
  }
  if (key_is(key, "flat")) {
    double depth = arg0 == YK_UNDEFINED ? 1 : to_number(arg0);
    if (depth != depth) depth = 0;
    yk_array *r = new_array(a->len);
    flatten_into(r, a, depth);
    return *out = BOX(T_ARRAY, r), 1;
  }
  if (key_is(key, "flatMap")) {
    if (!is_closure(arg0)) type_error("flatMap mapper function is not callable");
    yk_array *r = new_array(a->len);
    for (uint32_t i = 0; i < a->len; i++) {
      if (array_hole(a, i)) continue;
      yk args[3] = {a->items[i], yk_number(i), recv};
      yk got = call_value(arg0, arg1, 3, args);
      if (is_array(got)) flatten_into(r, arr(got), 0);
      else push(r, got);
    }
    return *out = BOX(T_ARRAY, r), 1;
  }
  if (key_is(key, "lastIndexOf")) {
    int64_t k = argc > 1 ? integer_or_infinity(arg1) : len - 1;
    if (k < 0) k += len;
    if (k >= len) k = len - 1;
    for (; k >= 0; k--)
      if (!array_hole(a, (uint32_t)k) && strict_equal(a->items[k], arg0)) return *out = yk_number((double)k), 1;
    return *out = yk_number(-1), 1;
  }
  if (key_is(key, "reduceRight")) {
    if (!is_closure(arg0)) type_error("the callback is not a function");
    int64_t i = len - 1;
    yk acc;
    if (argc > 1) acc = arg1;
    else {
      while (i >= 0 && array_hole(a, (uint32_t)i)) i--;
      if (i < 0) type_error("Reduce of empty array with no initial value");
      acc = a->items[i--];
    }
    for (; i >= 0; i--) {
      if (i >= a->len || array_hole(a, (uint32_t)i)) continue;
      yk args[4] = {acc, a->items[i], yk_number((double)i), recv};
      acc = call_value(arg0, YK_UNDEFINED, 4, args);
    }
    return *out = acc, 1;
  }
  if (key_is(key, "reverse") || key_is(key, "toReversed")) {
    yk_array *r = key_is(key, "reverse") ? a : array_copy(a);
    for (uint32_t i = 0, j = r->len; i + 1 < j; i++, j--) {
      yk x = r->items[i];
      r->items[i] = r->items[j - 1];
      r->items[j - 1] = x;
    }
    r->holes = NULL, r->holes_n = 0;
    return *out = r == a ? recv : BOX(T_ARRAY, r), 1;
  }
  if (key_is(key, "toSorted")) {
    if (arg0 != YK_UNDEFINED && !is_closure(arg0)) type_error("The comparison function must be either a function or undefined");
    yk_array *r = array_copy(a);
    yk *tmp = alloc((size_t)(r->len + 1) * sizeof(yk));
    merge_sort(r->items, tmp, r->len, arg0);
    return *out = BOX(T_ARRAY, r), 1;
  }
  if (key_is(key, "with")) {
    int64_t k = integer_or_infinity(arg0);
    if (k < 0) k += len;
    if (k < 0 || k >= len) {
      char msg[64];
      snprintf(msg, sizeof msg, "Invalid index : %g", to_number(arg0));
      range_error(msg);
    }
    yk_array *r = array_copy(a);
    r->items[k] = arg1;
    return *out = BOX(T_ARRAY, r), 1;
  }
  int splice = key_is(key, "splice"), to_spliced = key_is(key, "toSpliced");
  if (splice || to_spliced) {
    int64_t start = relative(arg0, len, 0);
    int64_t del = argc == 0 ? 0 : argc == 1 ? len - start : relative(arg1, len - start, 0);
    if (argc > 1 && to_number(arg1) < 0) del = 0;
    uint64_t nins = argc > 2 ? argc - 2 : 0;
    yk_array *removed = new_array((uint32_t)del);
    for (int64_t i = 0; i < del; i++) push(removed, a->items[start + i]);
    yk_array *r = new_array((uint32_t)(len - del + (int64_t)nins));
    for (int64_t i = 0; i < start; i++) push(r, a->items[i]);
    for (uint64_t i = 0; i < nins; i++) push(r, argv[2 + i]);
    for (int64_t i = start + del; i < len; i++) push(r, a->items[i]);
    if (to_spliced) return *out = BOX(T_ARRAY, r), 1;
    /* splice: the array becomes the result, in place. */
    a->items = r->items, a->len = r->len, a->cap = r->cap, a->holes = NULL, a->holes_n = 0;
    return *out = BOX(T_ARRAY, removed), 1;
  }
  return 0;
}
static yk callback(yk f, yk_array *a, uint32_t i, yk recv) {
  yk args[3] = {a->items[i], yk_number(i), recv};
  return call_value(f, YK_UNDEFINED, 3, args);
}

/* SortCompare: undefined last; the comparator's number, or the strings' order. */
static int sort_before(yk cmp, yk x, yk y) {
  if (x == YK_UNDEFINED) return 0;
  if (y == YK_UNDEFINED) return 1;
  if (cmp != YK_UNDEFINED) {
    yk args[2] = {y, x};
    double d = to_number(call_value(cmp, YK_UNDEFINED, 2, args));
    return d > 0; /* y after x reversed: x strictly before y */
  }
  return less_than(to_string(x), to_string(y)) == 1;
}

static void merge_sort(yk *items, yk *tmp, uint32_t n, yk cmp) {
  if (n < 2) return;
  uint32_t h = n / 2;
  merge_sort(items, tmp, h, cmp);
  merge_sort(items + h, tmp, n - h, cmp);
  uint32_t i = 0, j = h, k = 0;
  while (i < h && j < n) tmp[k++] = sort_before(cmp, items[j], items[i]) ? items[j++] : items[i++];
  while (i < h) tmp[k++] = items[i++];
  while (j < n) tmp[k++] = items[j++];
  memcpy(items, tmp, (size_t)n * sizeof(yk));
}

static int same_value_zero(yk a, yk b) {
  if (is_number(a) && is_number(b)) {
    double x = num(a), y = num(b);
    return x == y || (x != x && y != y);
  }
  return strict_equal(a, b);
}

/* The array builtins that take a function. */
static int array_callback_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  yk_array *a = arr(recv);
  yk f = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (key_is(key, "includes")) {
    for (uint32_t i = 0; i < a->len; i++)
      if (same_value_zero(a->items[i], f)) return *out = YK_TRUE, 1;
    return *out = YK_FALSE, 1;
  }
  if (key_is(key, "sort")) {
    if (f != YK_UNDEFINED && !is_closure(f)) type_error("the comparator is not a function");
    yk *tmp = alloc((size_t)(a->len + 1) * sizeof(yk)); /* values: the collector's, not freed */
    merge_sort(a->items, tmp, a->len, f);
    return *out = recv, 1;
  }
  int map = key_is(key, "map"), each = key_is(key, "forEach"), filter = key_is(key, "filter"),
      some = key_is(key, "some"), every = key_is(key, "every"), find = key_is(key, "find"),
      find_index = key_is(key, "findIndex"), reduce = key_is(key, "reduce");
  if (!(map || each || filter || some || every || find || find_index || reduce)) return 0;
  if (!is_closure(f)) type_error("the callback is not a function");
  uint32_t len = a->len;
  if (reduce) {
    uint32_t i = 0;
    yk acc;
    if (argc > 1)
      acc = argv[1];
    else {
      while (i < len && array_hole(a, i)) i++; /* the first index it has */
      if (i >= len) type_error("Reduce of empty array with no initial value");
      acc = a->items[i++];
    }
    for (; i < len && i < a->len; i++) {
      if (array_hole(a, i)) continue;
      yk args[4] = {acc, a->items[i], yk_number(i), recv};
      acc = call_value(f, YK_UNDEFINED, 4, args);
    }
    return *out = acc, 1;
  }
  yk_array *r = new_array(len);
  for (uint32_t i = 0; i < len && i < a->len; i++) {
    yk v = a->items[i];
    if (!find && !find_index && array_hole(a, i)) {
      if (map) push(r, YK_UNDEFINED), array_mark_hole(r, i, 1); /* map keeps the hole */
      continue;
    }
    yk got = callback(f, a, i, recv);
    if (map) push(r, got);
    if (filter && yk_truthy(got)) push(r, v);
    if (some && yk_truthy(got)) return *out = YK_TRUE, 1;
    if (every && !yk_truthy(got)) return *out = YK_FALSE, 1;
    if (find && yk_truthy(got)) return *out = v, 1;
    if (find_index && yk_truthy(got)) return *out = yk_number(i), 1;
  }
  if (map || filter) return *out = BOX(T_ARRAY, r), 1;
  if (each) return *out = YK_UNDEFINED, 1;
  if (some) return *out = YK_FALSE, 1;
  if (every) return *out = YK_TRUE, 1;
  if (find) return *out = YK_UNDEFINED, 1;
  return *out = yk_number(-1), 1;
}

/* --- bitwise operators, on ToInt32 / ToUint32 --- */

static uint32_t to_uint32(yk v) {
  /* A number below 2^63 in magnitude: its int64 conversion truncates, and its low 32 bits are the
     value modulo 2^32, as ECMA-262's ToUint32. */
  if (is_number(v) && fabs(num(v)) < 9.2e18) return (uint32_t)(int64_t)num(v);
  double d = to_number(v);
  if (d != d || isinf(d)) return 0;
  d = trunc(d);
  d = fmod(d, 4294967296.0);
  if (d < 0) d += 4294967296.0;
  return (uint32_t)d;
}
static int32_t to_int32(yk v) { return (int32_t)to_uint32(v); }

yk yk_bitor(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '|') : yk_number(to_int32(a) | to_int32(b)); }
yk yk_bitand(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '&') : yk_number(to_int32(a) & to_int32(b)); }
yk yk_bitxor(yk a, yk b) { return numeric_pair(&a, &b) ? big_binary(a, b, '^') : yk_number(to_int32(a) ^ to_int32(b)); }
yk yk_shl(yk a, yk b) {
  if (numeric_pair(&a, &b)) return big_binary(a, b, '<');
  return yk_number((int32_t)((uint32_t)to_int32(a) << (to_uint32(b) & 31)));
}
yk yk_shr(yk a, yk b) {
  if (numeric_pair(&a, &b)) return big_binary(a, b, '>');
  return yk_number(to_int32(a) >> (to_uint32(b) & 31));
}
yk yk_ushr(yk a, yk b) {
  if (numeric_pair(&a, &b)) type_error("BigInts have no unsigned right shift, use >> instead");
  return yk_number(to_uint32(a) >> (to_uint32(b) & 31));
}
yk yk_bitnot(yk a) {
  a = to_primitive(a);
  return is_bigint(a) ? big_add_small(big_negate(a), -1) : yk_number(~to_int32(a));
}

/* --- BigInt (ECMA-262 6.1.6.2), and the fixed-width and float64-bits leaves --------------------
 *
 * A BigInt is a sign and a magnitude of 32-bit limbs, least significant first, with no zero limb
 * at the top (zero has none, and is never negative). Every operation is exact, as ECMAScript's:
 * arbitrary precision, division truncating, `>>` flooring, the bitwise operators on the infinite
 * two's complement. The leaves of DEC-DUC-OPERATIONS-AS-ATOMS-001 that C's fixed-width integers
 * and a float64's bits are raised to are defined here as their JavaScript definitions
 * (`raise-c.ts`'s C_LEAVES_JS) define them.
 */

static void range_error(const char *what) { yk_throw(make_error("RangeError", ascii(what))); }

static yk_bigint *big_new(uint32_t len) {
  yk_bigint *b = alloc(sizeof(yk_bigint) + (size_t)len * 4);
  b->neg = 0;
  b->len = len;
  return b;
}
/* Its top zero limbs dropped, and a zero's sign cleared: the normal form. */
static yk big_box(yk_bigint *b) {
  while (b->len > 0 && b->d[b->len - 1] == 0) b->len--;
  if (b->len == 0) b->neg = 0;
  return BOX(T_BIGINT, b);
}
static yk_bigint *big(yk v) { return (yk_bigint *)PTR(v); }

static yk big_from_u64(uint64_t m, int neg) {
  yk_bigint *b = big_new(2);
  b->d[0] = (uint32_t)m;
  b->d[1] = (uint32_t)(m >> 32);
  b->neg = neg;
  return big_box(b);
}
static yk big_from_i64(int64_t x) {
  return x < 0 ? big_from_u64((uint64_t)0 - (uint64_t)x, 1) : big_from_u64((uint64_t)x, 0);
}

/* |a| compared with |b|: -1, 0 or 1. */
static int mag_cmp(const yk_bigint *a, const yk_bigint *b) {
  if (a->len != b->len) return a->len < b->len ? -1 : 1;
  for (uint32_t i = a->len; i-- > 0;)
    if (a->d[i] != b->d[i]) return a->d[i] < b->d[i] ? -1 : 1;
  return 0;
}
static yk_bigint *mag_add(const yk_bigint *a, const yk_bigint *b) {
  uint32_t n = (a->len > b->len ? a->len : b->len) + 1;
  yk_bigint *r = big_new(n);
  uint64_t carry = 0;
  for (uint32_t i = 0; i < n; i++) {
    uint64_t t = carry + (i < a->len ? a->d[i] : 0) + (i < b->len ? b->d[i] : 0);
    r->d[i] = (uint32_t)t;
    carry = t >> 32;
  }
  return r;
}
/* |a| - |b|, for |a| >= |b|. */
static yk_bigint *mag_sub(const yk_bigint *a, const yk_bigint *b) {
  yk_bigint *r = big_new(a->len);
  int64_t borrow = 0;
  for (uint32_t i = 0; i < a->len; i++) {
    int64_t t = (int64_t)a->d[i] - (i < b->len ? b->d[i] : 0) - borrow;
    borrow = t < 0;
    r->d[i] = (uint32_t)(t + (borrow ? ((int64_t)1 << 32) : 0));
  }
  return r;
}
/* a + b with signs: the magnitudes added or subtracted. */
static yk big_add_signed(const yk_bigint *a, int aneg, const yk_bigint *b, int bneg) {
  yk_bigint *r;
  if (aneg == bneg) {
    r = mag_add(a, b);
    r->neg = aneg;
  } else if (mag_cmp(a, b) >= 0) {
    r = mag_sub(a, b);
    r->neg = aneg;
  } else {
    r = mag_sub(b, a);
    r->neg = bneg;
  }
  return big_box(r);
}
static yk big_mul(const yk_bigint *a, const yk_bigint *b) {
  yk_bigint *r = big_new(a->len + b->len);
  memset(r->d, 0, (size_t)r->len * 4);
  for (uint32_t i = 0; i < a->len; i++) {
    uint64_t carry = 0;
    for (uint32_t j = 0; j < b->len; j++) {
      uint64_t t = (uint64_t)a->d[i] * b->d[j] + r->d[i + j] + carry;
      r->d[i + j] = (uint32_t)t;
      carry = t >> 32;
    }
    for (uint32_t k = i + b->len; carry != 0; k++) {
      uint64_t t = (uint64_t)r->d[k] + carry;
      r->d[k] = (uint32_t)t;
      carry = t >> 32;
    }
  }
  r->neg = a->neg != b->neg;
  return big_box(r);
}
static uint64_t mag_bitlen(const yk_bigint *a) {
  if (a->len == 0) return 0;
  uint32_t top = a->d[a->len - 1];
  int bits = 0;
  while (top != 0) bits++, top >>= 1;
  return (uint64_t)(a->len - 1) * 32 + bits;
}
static int mag_bit(const yk_bigint *a, uint64_t i) {
  uint64_t limb = i / 32;
  return limb < a->len ? (a->d[limb] >> (i % 32)) & 1 : 0;
}
/* |a| / |b| and |a| % |b| (b nonzero), by shifting and subtracting. */
static void mag_divmod(const yk_bigint *a, const yk_bigint *b, yk_bigint **q, yk_bigint **r) {
  yk_bigint *quo = big_new(a->len);
  memset(quo->d, 0, (size_t)quo->len * 4);
  yk_bigint *rem = big_new(b->len + 1);
  memset(rem->d, 0, (size_t)rem->len * 4);
  rem->len = 0;
  for (uint64_t i = mag_bitlen(a); i-- > 0;) {
    /* rem = rem * 2 + bit i of a */
    uint32_t carry = (uint32_t)mag_bit(a, i);
    for (uint32_t k = 0; k < rem->len; k++) {
      uint32_t next = rem->d[k] >> 31;
      rem->d[k] = (rem->d[k] << 1) | carry;
      carry = next;
    }
    if (carry) rem->d[rem->len++] = carry;
    if (mag_cmp(rem, b) >= 0) {
      yk_bigint *t = mag_sub(rem, b);
      while (t->len > 0 && t->d[t->len - 1] == 0) t->len--;
      memcpy(rem->d, t->d, (size_t)t->len * 4);
      rem->len = t->len;
      quo->d[i / 32] |= 1u << (i % 32);
    }
  }
  *q = quo;
  *r = rem;
}

/* The infinite two's complement of a, in n limbs (n past its magnitude: the sign extends). */
static void twos(const yk_bigint *a, uint32_t *out, uint32_t n) {
  for (uint32_t i = 0; i < n; i++) out[i] = i < a->len ? a->d[i] : 0;
  if (!a->neg) return;
  uint64_t carry = 1;
  for (uint32_t i = 0; i < n; i++) {
    uint64_t t = (uint64_t)(uint32_t)~out[i] + carry;
    out[i] = (uint32_t)t;
    carry = t >> 32;
  }
}
/* A two's complement of n limbs (its top limb's top bit the sign) as a BigInt. */
static yk from_twos(const uint32_t *in, uint32_t n) {
  yk_bigint *r = big_new(n);
  int neg = n > 0 && (in[n - 1] >> 31);
  memcpy(r->d, in, (size_t)n * 4);
  if (neg) {
    uint64_t carry = 1;
    for (uint32_t i = 0; i < n; i++) {
      uint64_t t = (uint64_t)(uint32_t)~r->d[i] + carry;
      r->d[i] = (uint32_t)t;
      carry = t >> 32;
    }
  }
  r->neg = neg;
  return big_box(r);
}
static yk big_bitwise(const yk_bigint *a, const yk_bigint *b, char op) {
  uint32_t n = (a->len > b->len ? a->len : b->len) + 1;
  uint32_t *x = alloc((size_t)n * 4), *y = alloc((size_t)n * 4);
  twos(a, x, n);
  twos(b, y, n);
  for (uint32_t i = 0; i < n; i++) x[i] = op == '&' ? x[i] & y[i] : op == '|' ? x[i] | y[i] : x[i] ^ y[i];
  return from_twos(x, n);
}

/* a * 2^k (k >= 0). */
static yk big_shl_mag(const yk_bigint *a, int neg, uint64_t k) {
  if (a->len == 0) return big_from_u64(0, 0);
  if (k > (uint64_t)1 << 30) range_error("Maximum BigInt size exceeded");
  uint32_t words = (uint32_t)(k / 32), bits = (uint32_t)(k % 32);
  yk_bigint *r = big_new(a->len + words + 1);
  memset(r->d, 0, (size_t)r->len * 4);
  for (uint32_t i = 0; i < a->len; i++) {
    uint64_t t = (uint64_t)a->d[i] << bits;
    r->d[i + words] |= (uint32_t)t;
    r->d[i + words + 1] |= (uint32_t)(t >> 32);
  }
  r->neg = neg;
  return big_box(r);
}
/* floor(a / 2^k) (k >= 0). */
static yk big_sar(const yk_bigint *a, uint64_t k) {
  if (!a->neg) {
    uint64_t words = k / 32;
    uint32_t bits = (uint32_t)(k % 32);
    if (words >= a->len) return big_from_u64(0, 0);
    yk_bigint *r = big_new(a->len - (uint32_t)words);
    for (uint32_t i = 0; i < r->len; i++) {
      uint64_t lo = a->d[i + words];
      uint64_t hi = i + words + 1 < a->len ? a->d[i + words + 1] : 0;
      r->d[i] = (uint32_t)(((hi << 32) | lo) >> bits);
    }
    return big_box(r);
  }
  /* A negative's: -(((|a| - 1) >> k) + 1). */
  yk_bigint *one_p = big_new(1);
  one_p->d[0] = 1;
  yk_bigint *m = mag_sub(a, one_p);
  m->neg = 0;
  yk s = big_sar(big(big_box(m)), k);
  yk_bigint *r = mag_add(big(s), one_p);
  r->neg = 1;
  return big_box(r);
}
static int64_t shift_count(const yk_bigint *b) {
  if (b->len > 1 || (b->len == 1 && b->d[0] > (1u << 30))) return b->neg ? INT64_MIN : INT64_MAX;
  int64_t k = b->len == 0 ? 0 : b->d[0];
  return b->neg ? -k : k;
}
static yk big_shift(const yk_bigint *a, const yk_bigint *b, int left) {
  int64_t k = shift_count(b);
  if (!left) k = k == INT64_MIN ? INT64_MAX : -k;
  if (k >= 0) return big_shl_mag(a, a->neg, (uint64_t)k);
  return big_sar(a, k == INT64_MIN ? (uint64_t)INT64_MAX : (uint64_t)(-k));
}

/* The low 64 bits of a's two's complement: BigInt.asUintN(64, a). */
static uint64_t big_low64(const yk_bigint *a) {
  uint32_t w[2];
  twos(a, w, 2);
  return ((uint64_t)w[1] << 32) | w[0];
}

/* Number(a): the nearest double, ties to even. */
static double big_to_double(const yk_bigint *a) {
  uint64_t L = mag_bitlen(a);
  double r;
  if (L <= 64) {
    uint64_t m = a->len == 0 ? 0 : a->len == 1 ? a->d[0] : ((uint64_t)a->d[1] << 32) | a->d[0];
    r = (double)m;
  } else {
    /* The top 64 bits, with every lower bit folded into the last (a sticky bit). */
    uint64_t t = 0;
    for (uint64_t i = 0; i < 64; i++) t |= (uint64_t)mag_bit(a, L - 64 + i) << i;
    for (uint64_t i = 0; i < L - 64; i++)
      if (mag_bit(a, i)) {
        t |= 1;
        break;
      }
    r = ldexp((double)t, (int)(L - 64 > 2000 ? 2000 : L - 64));
  }
  return a->neg ? -r : r;
}

/* BigInt(x) for a number: a RangeError unless it is an integer. */
static yk big_from_double(double x) {
  if (x != x || isinf(x) || trunc(x) != x) {
    yk s = number_to_string(x);
    yk msg = concat(str(concat(str(ascii("The number ")), str(s))),
                    str(ascii(" cannot be converted to a BigInt because it is not an integer")));
    yk_throw(make_error("RangeError", msg));
  }
  int neg = x < 0;
  double m = fabs(x);
  if (m < 18446744073709551616.0) return big_from_u64((uint64_t)m, neg);
  int e;
  double f = frexp(m, &e); /* m = f * 2^e, f in [0.5, 1) */
  uint64_t mant = (uint64_t)ldexp(f, 53);
  yk_bigint *b = big(big_from_u64(mant, 0));
  return big_shl_mag(b, neg, (uint64_t)(e - 53));
}

/* The BigInt's decimal digits. */
static yk big_to_string(const yk_bigint *a) {
  if (a->len == 0) return ascii("0");
  uint32_t n = a->len;
  uint32_t *w = alloc((size_t)n * 4);
  memcpy(w, a->d, (size_t)n * 4);
  size_t cap = (size_t)n * 10 + 2, k = 0;
  char *digits = alloc(cap);
  while (n > 0) {
    uint64_t rem = 0;
    for (uint32_t i = n; i-- > 0;) {
      uint64_t cur = (rem << 32) | w[i];
      w[i] = (uint32_t)(cur / 1000000000u);
      rem = cur % 1000000000u;
    }
    while (n > 0 && w[n - 1] == 0) n--;
    for (int j = 0; j < 9 && (n > 0 || rem > 0); j++) {
      digits[k++] = (char)('0' + rem % 10);
      rem /= 10;
    }
  }
  char *out = alloc(k + 2);
  size_t o = 0;
  if (a->neg) out[o++] = '-';
  while (k > 0) out[o++] = digits[--k];
  out[o] = 0;
  return ascii(out);
}

/* StringToBigInt over UTF-16 units: undefined (0) when the string is not one. */
static yk big_from_units(const uint16_t *u, uint32_t len, int literal) {
  uint32_t a = 0, b = len;
  if (!literal) {
    while (a < b && is_space(u[a])) a++;
    while (b > a && is_space(u[b - 1])) b--;
    if (a == b) return big_from_u64(0, 0);
  }
  int neg = 0, radix = 10;
  if (b - a >= 2 && u[a] == '0' && (u[a + 1] | 32) == 'x') radix = 16, a += 2;
  else if (b - a >= 2 && u[a] == '0' && (u[a + 1] | 32) == 'o') radix = 8, a += 2;
  else if (b - a >= 2 && u[a] == '0' && (u[a + 1] | 32) == 'b') radix = 2, a += 2;
  else if (!literal && (u[a] == '+' || u[a] == '-')) neg = u[a] == '-', a++;
  if (a == b) return 0;
  yk_bigint *r = big_new((b - a) / 2 + 2);
  memset(r->d, 0, (size_t)r->len * 4);
  for (uint32_t i = a; i < b; i++) {
    uint16_t c = u[i];
    if (literal && c == '_') continue;
    int d = c >= '0' && c <= '9' ? c - '0' : (c | 32) >= 'a' && (c | 32) <= 'z' ? (c | 32) - 'a' + 10 : 99;
    if (d >= radix) return 0;
    uint64_t carry = (uint64_t)d;
    for (uint32_t k = 0; k < r->len; k++) {
      uint64_t t = (uint64_t)r->d[k] * radix + carry;
      r->d[k] = (uint32_t)t;
      carry = t >> 32;
    }
  }
  r->neg = neg;
  return big_box(r);
}
/* A BigInt literal's value (the n dropped): its digits, as the lowering writes them. */
yk yk_bigint_literal(const char *p, uint64_t n) {
  uint16_t *u = alloc((size_t)n * 2 + 2);
  for (uint64_t i = 0; i < n; i++) u[i] = (uint8_t)p[i];
  yk v = big_from_units(u, (uint32_t)n, 1);
  if (v == 0) type_error("not a BigInt literal");
  return v;
}

/* a compared with a number: -1, 0 or 1; 2 when the number is NaN. */
static int big_cmp_double(const yk_bigint *a, double y) {
  if (y != y) return 2;
  if (isinf(y)) return y > 0 ? -1 : 1;
  double fy = floor(y);
  yk b = big_from_double(fy);
  yk_bigint *bb = big(b);
  int c;
  if (a->neg != bb->neg) c = a->neg ? -1 : 1;
  else {
    c = mag_cmp(a, bb);
    if (a->neg) c = -c;
  }
  if (c != 0) return c;
  return fy < y ? -1 : 0; /* a == floor(y): below y if y has a fraction */
}
static int big_cmp(const yk_bigint *a, const yk_bigint *b) {
  if (a->neg != b->neg) return a->neg ? -1 : 1;
  int c = mag_cmp(a, b);
  return a->neg ? -c : c;
}

static void mix_error(void) { type_error("Cannot mix BigInt and other types, use explicit conversions"); }

#ifdef __SIZEOF_INT128__
/* A BigInt of at most two limbs (|x| < 2^64) as a signed 128-bit integer. */
static int big_small(const yk_bigint *x, __int128 *out) {
  if (x->len > 2) return 0;
  unsigned __int128 m = x->len == 0 ? 0 : x->len == 1 ? x->d[0] : ((unsigned __int128)x->d[1] << 32) | x->d[0];
  *out = x->neg ? -(__int128)m : (__int128)m;
  return 1;
}
/* A signed 128-bit integer as a BigInt. */
static yk big_from_i128(__int128 v) {
  int neg = v < 0;
  unsigned __int128 m = neg ? (unsigned __int128)0 - (unsigned __int128)v : (unsigned __int128)v;
  yk_bigint *r = big_new(4);
  for (int i = 0; i < 4; i++) r->d[i] = (uint32_t)(m >> (32 * i));
  r->neg = neg;
  return big_box(r);
}
#endif

/* An arithmetic or bitwise operator of two BigInts. */
static yk big_binary(yk a, yk b, char op) {
  yk_bigint *x = big(a), *y = big(b);
  /* Both below 2^64 in magnitude: 128-bit arithmetic computes exactly what the limbs do. A sum or
     difference stays below 2^65 and a product below 2^128 in magnitude (a product's sign apart);
     the bitwise operators are the two's complement's; a shift's result is checked to fit. */
#ifdef __SIZEOF_INT128__
  __int128 p, q;
  if (big_small(x, &p) && big_small(y, &q)) {
    switch (op) {
    case '+': return big_from_i128(p + q);
    case '-': return big_from_i128(p - q);
    case '*': {
      unsigned __int128 mp = p < 0 ? (unsigned __int128)0 - (unsigned __int128)p : (unsigned __int128)p;
      unsigned __int128 mq = q < 0 ? (unsigned __int128)0 - (unsigned __int128)q : (unsigned __int128)q;
      unsigned __int128 m = mp * mq;
      if ((m >> 127) == 0) {
        __int128 v = (__int128)m;
        return big_from_i128((p < 0) != (q < 0) ? -v : v);
      }
      break; /* 2^127 or more: the limbs' */
    }
    case '&': return big_from_i128(p & q);
    case '|': return big_from_i128(p | q);
    case '^': return big_from_i128(p ^ q);
    case '>':
      if (q >= 0) return big_from_i128(q >= 127 ? (p < 0 ? -1 : 0) : p >> q);
      break;
    case '<':
      if (q >= 0 && q <= 62) return big_from_i128(p * ((__int128)1 << q));
      break;
    default:
      break;
    }
  }
#endif
  switch (op) {
  case '+':
    return big_add_signed(x, x->neg, y, y->neg);
  case '-':
    return big_add_signed(x, x->neg, y, !y->neg && y->len > 0);
  case '*':
    return big_mul(x, y);
  case '/':
  case '%': {
    if (y->len == 0) range_error("Division by zero");
    yk_bigint *q, *r;
    mag_divmod(x, y, &q, &r);
    if (op == '/') {
      q->neg = x->neg != y->neg;
      return big_box(q);
    }
    r->neg = x->neg;
    return big_box(r);
  }
  case '&':
  case '|':
  case '^':
    return big_bitwise(x, y, op);
  case '<':
    return big_shift(x, y, 1);
  case '>':
    return big_shift(x, y, 0);
  }
  return YK_UNDEFINED;
}
/* The operands as numbers or BigInts: 1 when both are BigInts, 0 when neither, else a TypeError. */
static int numeric_pair(yk *a, yk *b) {
  *a = to_primitive(*a);
  *b = to_primitive(*b);
  int x = is_bigint(*a), y = is_bigint(*b);
  if (x && y) return 1;
  if (x || y) mix_error();
  return 0;
}

/* a ** b's first steps (ECMA-262 13.6): ToNumeric of each, once. Two BigInts: the exact power, in
   out[0], and 1. A BigInt and a Number: a TypeError. Two Numbers: out[0] and out[1], and 0; the
   lowering then calls pow's atom (Number::exponentiate is Math.pow). */
int32_t yk_exponent(yk a, yk b, yk *out) {
  if (numeric_pair(&a, &b)) {
    const yk_bigint *e = big(b);
    if (e->neg) range_error("Exponent must be non-negative");
    const yk_bigint *x = big(a);
    yk one = big_from_u64(1, 0);
    if (e->len == 0) return out[0] = one, 1;
    if (x->len == 0) return out[0] = a, 1;
    if (x->len == 1 && x->d[0] == 1) {
      int odd = e->d[0] & 1;
      return out[0] = x->neg && odd ? a : one, 1;
    }
    if (e->len > 1 || e->d[0] > (1u << 30)) range_error("Maximum BigInt size exceeded");
    uint32_t k = e->d[0];
    yk r = one, base = a;
    while (k > 0) {
      if (k & 1) r = big_binary(r, base, '*');
      k >>= 1;
      if (k > 0) base = big_binary(base, base, '*');
    }
    return out[0] = r, 1;
  }
  out[0] = yk_number(to_number(a));
  out[1] = yk_number(to_number(b));
  return 0;
}

/* A 128-bit two's complement integer (as its low and high words) as a BigInt: the typed
   lowering's boxing of the BigInts it keeps unboxed (#1369). Portable: no __int128 needed. */
yk yk_bigint_from_i128(uint64_t lo, uint64_t hi) {
  uint32_t w[4] = {(uint32_t)lo, (uint32_t)(lo >> 32), (uint32_t)hi, (uint32_t)(hi >> 32)};
  return from_twos(w, 4);
}

/* Word i (0 low, 1 high) of a BigInt's 128-bit two's complement (the typed lowering's unboxing of a
   value it proved fits). */
uint64_t yk_bigint_word(yk b, int32_t i) {
  uint32_t w[4];
  twos(big(b), w, 4);
  return ((uint64_t)w[2 * i + 1] << 32) | w[2 * i];
}

/* --- the leaves --- */

yk yk_leaf_i32mul(yk a, yk b) { return yk_number((int32_t)((uint32_t)to_int32(a) * (uint32_t)to_int32(b))); }
static yk_bigint *want_big(yk v) {
  if (!is_bigint(v)) type_error("Cannot convert to a BigInt");
  return big(v);
}
yk yk_leaf_u64(yk x) { return big_from_u64(big_low64(want_big(x)), 0); }
yk yk_leaf_i64(yk x) { return big_from_i64((int64_t)big_low64(want_big(x))); }
yk yk_leaf_num_to_big(yk x) {
  if (is_bigint(x)) return x;
  return big_from_double(to_number(x));
}
yk yk_leaf_big_to_i32(yk x) { return yk_number((int32_t)(uint32_t)big_low64(want_big(x))); }
yk yk_leaf_big_to_u32(yk x) { return yk_number((uint32_t)big_low64(want_big(x))); }
yk yk_leaf_big_to_f64(yk x) { return yk_number(big_to_double(want_big(x))); }
yk yk_leaf_f64_to_i64(yk x) {
  yk b = big_from_double(trunc(to_number(x)));
  return big_from_i64((int64_t)big_low64(big(b)));
}
yk yk_leaf_f64_bits(yk x) {
  double d = to_number(x);
  uint64_t u;
  memcpy(&u, &d, 8);
  return big_from_u64(u, 0);
}
yk yk_leaf_f64_from_bits(yk x) {
  uint64_t u = big_low64(want_big(x));
  double d;
  memcpy(&d, &u, 8);
  return yk_number(d);
}
yk yk_leaf_f64_hi(yk x) {
  double d = to_number(x);
  uint64_t u;
  memcpy(&u, &d, 8);
  return yk_number((double)(uint32_t)(u >> 32));
}
yk yk_leaf_f64_lo(yk x) {
  double d = to_number(x);
  uint64_t u;
  memcpy(&u, &d, 8);
  return yk_number((double)(uint32_t)u);
}
yk yk_leaf_f64_make(yk hi, yk lo) {
  uint64_t u = ((uint64_t)to_uint32(hi) << 32) | to_uint32(lo);
  double d;
  memcpy(&d, &u, 8);
  return yk_number(d);
}

static yk big_to_string_v(yk v) { return big_to_string(big(v)); }
static double big_to_double_v(yk v) { return big_to_double(big(v)); }
static int big_cmp_v(yk a, yk b) { return big_cmp(big(a), big(b)); }
static int big_cmp_double_v(yk a, double y) { return big_cmp_double(big(a), y); }
static yk big_from_string_v(yk s) { return big_from_units(str(s)->units, str(s)->len, 0); }
static yk big_negate(yk a) {
  yk_bigint *x = big(a), *r = big_new(x->len);
  memcpy(r->d, x->d, (size_t)x->len * 4);
  r->neg = !x->neg;
  return big_box(r);
}
static yk big_add_small(yk a, int64_t k) { return big_binary(a, big_from_i64(k), '+'); }

/* --- Map and Set: entries in insertion order, keys compared by SameValueZero --- */

static yk new_collection(int32_t kind) {
  yk v = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(v);
  o->kind = kind;
  o->entries = new_array(4);
  return v;
}

static int64_t collection_find(yk_object *o, yk key) {
  for (uint32_t i = 0; i < o->entries->len; i++) {
    yk k = o->kind == 1 ? arr(o->entries->items[i])->items[0] : o->entries->items[i];
    if (same_value_zero(k, key)) return i;
  }
  return -1;
}

static void collection_remove(yk_object *o, int64_t i) {
  memmove(o->entries->items + i, o->entries->items + i + 1, (size_t)(o->entries->len - i - 1) * sizeof(yk));
  o->entries->len--;
}

static yk_array *iterable_items(yk v);

static void collection_put(yk_object *o, yk key, yk value) {
  if (key == yk_number(-0.0)) key = yk_number(0); /* -0 is stored as +0 */
  int64_t i = collection_find(o, key);
  if (o->kind == 1) {
    if (i >= 0)
      arr(o->entries->items[i])->items[1] = value;
    else {
      yk pair[2] = {key, value};
      push(o->entries, yk_array_of(2, pair));
    }
  } else if (i < 0)
    push(o->entries, key);
}


/* ES2025's Set methods (union, intersection, …): the other is set-like (GetSetRecord: a size that is
   a number, callable has and keys), its keys walked by its own keys(), and the order of the result
   as the spec builds it. */
static int set_method(yk_object *o, yk key, yk other, yk *out) {
  static const char *const names[] = {"union", "intersection", "difference", "symmetricDifference",
                                      "isSubsetOf", "isSupersetOf", "isDisjointFrom"};
  int which = -1;
  for (int k = 0; k < 7; k++)
    if (key_is(key, names[k])) which = k;
  if (which < 0) return 0;
  char msg[96];
  if (!is_object(other) && !is_closure(other)) {
    snprintf(msg, sizeof msg, "Set.prototype.%s argument must be an object", names[which]);
    type_error(msg);
  }
  yk rawsize = yk_get(other, ascii("size"));
  double size = to_number(rawsize);
  if (size != size) type_error("The .size property is NaN");
  size = trunc(size);
  if (size < 0) {
    yk m = concat(str(ascii("'")), str(to_string(yk_number(size))));
    yk_throw(make_error("RangeError", concat(str(m), str(ascii("' is an invalid size")))));
  }
  yk has = yk_get(other, ascii("has")), keys = yk_get(other, ascii("keys"));
  if (!is_closure(has)) type_error("string \"has\" is not a function");
  if (!is_closure(keys)) type_error("string \"keys\" is not a function");
  double mine = o->entries->len;
  yk_array *ks = NULL;
  /* The other's keys, as its keys() gives them (iterated by its next). */
#define OTHER_KEYS()                                                                     \
  do {                                                                                     \
    ks = new_array(4);                                                                     \
    yk it = call_value(keys, other, 0, NULL);                                              \
    if (!is_object(it) && !is_closure(it)) type_error("Result of the keys method is not an object"); \
    yk next_key = ascii("next");                                                           \
    for (;;) {                                                                             \
      yk r = call_method_key(it, next_key, 0, NULL);                                       \
      if (!is_object(r)) type_error("Iterator result is not an object");                  \
      if (yk_truthy(yk_get(r, ascii("done")))) break;                                      \
      yk v = yk_get(r, ascii("value"));                                                    \
      push(ks, is_number(v) && num(v) == 0 ? yk_number(0) : v);                            \
    }                                                                                      \
  } while (0)
#define OTHER_HAS(e) yk_truthy(call_value(has, other, 1, &(e)))
  yk r = new_collection(2);
  yk_object *ro = (yk_object *)PTR(r);
  switch (which) {
  case 0: /* union */
    for (uint32_t j = 0; j < o->entries->len; j++) collection_put(ro, o->entries->items[j], YK_UNDEFINED);
    OTHER_KEYS();
    for (uint32_t j = 0; j < ks->len; j++) collection_put(ro, ks->items[j], YK_UNDEFINED);
    return *out = r, 1;
  case 1: /* intersection */
    if (mine <= size) {
      for (uint32_t j = 0; j < o->entries->len; j++) {
        yk e = o->entries->items[j];
        if (OTHER_HAS(e)) collection_put(ro, e, YK_UNDEFINED);
      }
    } else {
      OTHER_KEYS();
      for (uint32_t j = 0; j < ks->len; j++)
        if (collection_find(o, ks->items[j]) >= 0) collection_put(ro, ks->items[j], YK_UNDEFINED);
    }
    return *out = r, 1;
  case 2: /* difference */
    for (uint32_t j = 0; j < o->entries->len; j++) collection_put(ro, o->entries->items[j], YK_UNDEFINED);
    if (mine <= size) {
      for (uint32_t j = 0; j < o->entries->len; j++) {
        yk e = o->entries->items[j];
        int64_t at;
        if (OTHER_HAS(e) && (at = collection_find(ro, e)) >= 0) collection_remove(ro, at);
      }
    } else {
      OTHER_KEYS();
      for (uint32_t j = 0; j < ks->len; j++) {
        int64_t at = collection_find(ro, ks->items[j]);
        if (at >= 0) collection_remove(ro, at);
      }
    }
    return *out = r, 1;
  case 3: /* symmetricDifference */
    for (uint32_t j = 0; j < o->entries->len; j++) collection_put(ro, o->entries->items[j], YK_UNDEFINED);
    OTHER_KEYS();
    for (uint32_t j = 0; j < ks->len; j++) {
      yk k = ks->items[j];
      int64_t at;
      if (collection_find(o, k) >= 0) {
        if ((at = collection_find(ro, k)) >= 0) collection_remove(ro, at);
      } else
        collection_put(ro, k, YK_UNDEFINED);
    }
    return *out = r, 1;
  case 4: /* isSubsetOf */
    if (mine > size) return *out = YK_FALSE, 1;
    for (uint32_t j = 0; j < o->entries->len; j++) {
      yk e = o->entries->items[j];
      if (!OTHER_HAS(e)) return *out = YK_FALSE, 1;
    }
    return *out = YK_TRUE, 1;
  case 5: /* isSupersetOf */
    if (mine < size) return *out = YK_FALSE, 1;
    OTHER_KEYS();
    for (uint32_t j = 0; j < ks->len; j++)
      if (collection_find(o, ks->items[j]) < 0) return *out = YK_FALSE, 1;
    return *out = YK_TRUE, 1;
  default: /* isDisjointFrom */
    if (mine <= size) {
      for (uint32_t j = 0; j < o->entries->len; j++) {
        yk e = o->entries->items[j];
        if (OTHER_HAS(e)) return *out = YK_FALSE, 1;
      }
    } else {
      OTHER_KEYS();
      for (uint32_t j = 0; j < ks->len; j++)
        if (collection_find(o, ks->items[j]) >= 0) return *out = YK_FALSE, 1;
    }
    return *out = YK_TRUE, 1;
  }
#undef OTHER_KEYS
#undef OTHER_HAS
}
static int collection_method(yk_object *o, yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  yk a0 = argc > 0 ? argv[0] : YK_UNDEFINED, a1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  int64_t i;
  if (key_is(key, "has")) return *out = yk_bool(collection_find(o, a0) >= 0), 1;
  if (o->kind == 1 && key_is(key, "get"))
    return *out = (i = collection_find(o, a0)) >= 0 ? arr(o->entries->items[i])->items[1] : YK_UNDEFINED, 1;
  if ((o->kind == 1 && key_is(key, "set")) || (o->kind == 2 && key_is(key, "add"))) {
    collection_put(o, a0, a1);
    return *out = recv, 1;
  }
  if (key_is(key, "delete")) {
    if ((i = collection_find(o, a0)) < 0) return *out = YK_FALSE, 1;
    collection_remove(o, i);
    return *out = YK_TRUE, 1;
  }
  if (key_is(key, "clear")) {
    o->entries->len = 0;
    return *out = YK_UNDEFINED, 1;
  }
  /* keys / values / entries: the items, as an array (iterable, as the iterators they stand for). */
  int keys = key_is(key, "keys"), values = key_is(key, "values"), entries = key_is(key, "entries");
  if (keys || values || entries) return *out = builtin_iter_new(recv, keys ? 0 : values ? 1 : 2, o->kind == 1 ? 2 : 3), 1;
  if (0) {
    yk_array *r = new_array(o->entries->len);
    for (uint32_t j = 0; j < o->entries->len; j++) {
      yk e = o->entries->items[j];
      if (o->kind == 1) push(r, entries ? yk_array_of(2, arr(e)->items) : arr(e)->items[keys ? 0 : 1]);
      else {
        yk pair[2] = {e, e};
        push(r, entries ? yk_array_of(2, pair) : e);
      }
    }
    return *out = BOX(T_ARRAY, r), 1;
  }
  if (o->kind == 2 && set_method(o, key, a0, out)) return 1;
  if (key_is(key, "forEach")) {
    for (uint32_t j = 0; j < o->entries->len; j++) {
      yk e = o->entries->items[j];
      yk args[3] = {o->kind == 1 ? arr(e)->items[1] : e, o->kind == 1 ? arr(e)->items[0] : e, recv};
      call_value(a0, a1, 3, args);
    }
    return *out = YK_UNDEFINED, 1;
  }
  return 0;
}

/* The items of an iterable, as for…of gives them: an array's, a string's code points, a Map's
 * [key, value] pairs, a Set's values. */
static yk_array *typed_items_v(yk v);
static yk_array *iterable_items(yk v) {
  if (is_object(v) && ((yk_object *)PTR(v))->kind == 7) return typed_items_v(v);
  yk_array *r = new_array(4);
  {
    int is_async = 0;
    if (protocol_method(v, 0, &is_async) != 0) {
      yk it = yk_iter_new(v, 0), e;
      while (yk_iter_next(it, &e)) push(r, e);
      return r;
    }
  }
  if (is_object(v) && ((yk_object *)PTR(v))->kind == 5) {
    yk e;
    while (generator_step(v, &e)) push(r, e);
    return r;
  }
  if (is_object(v) && (((yk_object *)PTR(v))->kind == 1 || ((yk_object *)PTR(v))->kind == 2)) {
    v = builtin_iter_new(v, ((yk_object *)PTR(v))->kind == 1 ? 2 : 1, ((yk_object *)PTR(v))->kind == 1 ? 2 : 3);
  }
  if (is_builtin_iter(v)) {
    yk e;
    while (builtin_iter_step(v, &e)) push(r, e);
    return r;
  }
  yk it = yk_iter_new(v, 0), e;
  while (yk_iter_next(it, &e)) push(r, e);
  return r;
}

/* --- JSON.stringify (no replacer, no indent) --- */

static void json_quote(yk_array *parts, yk_string *s) {
  yk_string *q = new_string(s->len * 6 + 2);
  uint32_t n = 0;
  q->units[n++] = '"';
  for (uint32_t i = 0; i < s->len; i++) {
    uint16_t c = s->units[i];
    int lone = (c >= 0xD800 && c <= 0xDBFF && !(i + 1 < s->len && s->units[i + 1] >= 0xDC00 && s->units[i + 1] <= 0xDFFF)) ||
               (c >= 0xDC00 && c <= 0xDFFF && !(i > 0 && s->units[i - 1] >= 0xD800 && s->units[i - 1] <= 0xDBFF));
    const char *esc = c == '"' ? "\\\"" : c == '\\' ? "\\\\" : c == '\b' ? "\\b" : c == '\f' ? "\\f" : c == '\n' ? "\\n" : c == '\r' ? "\\r" : c == '\t' ? "\\t" : NULL;
    if (esc != NULL)
      for (const char *e = esc; *e; e++) q->units[n++] = (uint16_t)*e;
    else if (c < 0x20 || lone) {
      char buf[8];
      snprintf(buf, sizeof buf, "\\u%04x", c);
      for (const char *e = buf; *e; e++) q->units[n++] = (uint16_t)*e;
    } else
      q->units[n++] = c;
  }
  q->units[n++] = '"';
  q->len = n;
  push(parts, string_of(q));
}

/* 0: nothing written (undefined, a function); 1: written. */
static int json_write(yk_array *parts, yk v) {
  if (v == YK_UNDEFINED || is_closure(v)) return 0;
  if (v == YK_NULL) return push(parts, ascii("null")), 1;
  if (is_bool(v)) return push(parts, ascii(v == YK_TRUE ? "true" : "false")), 1;
  if (is_number(v)) {
    double d = num(v);
    return push(parts, d != d || isinf(d) ? ascii("null") : to_string(v)), 1;
  }
  if (is_string(v)) return json_quote(parts, str(v)), 1;
  if (is_array(v)) {
    push(parts, ascii("["));
    for (uint32_t i = 0; i < arr(v)->len; i++) {
      if (i > 0) push(parts, ascii(","));
      if (!json_write(parts, arr(v)->items[i])) push(parts, ascii("null"));
    }
    return push(parts, ascii("]")), 1;
  }
  yk_object *o = (yk_object *)PTR(v);
  push(parts, ascii("{"));
  if (o->kind == 0) {
    yk_array *keys = enumerable_keys(o);
    int first = 1;
    for (uint32_t i = 0; i < keys->len; i++) {
      yk value;
      own_get(o, keys->items[i], &value);
      value = resolve_slot(value, v);
      if (value == YK_UNDEFINED || is_closure(value)) continue;
      if (!first) push(parts, ascii(","));
      first = 0;
      json_quote(parts, str(keys->items[i]));
      push(parts, ascii(":"));
      json_write(parts, value);
    }
  }
  return push(parts, ascii("}")), 1;
}

static yk builtin_json_stringify(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk_array *parts = new_array(16);
  if (!json_write(parts, argc > 0 ? argv[0] : YK_UNDEFINED)) return YK_UNDEFINED;
  return array_join(parts, str(ascii("")));
}

/* --- Array.from, Array.isArray, Object.keys / values / entries / assign / freeze, Map, Set --- */

static yk builtin_array_from(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (is_nullish(v)) type_error("Array.from needs an iterable or array-like");
  yk_array *items;
  int is_async = 0;
  if (protocol_method(v, 0, &is_async) != 0)
    items = iterable_items(v);
  else if (is_array(v) || is_string(v) ||
      (is_object(v) && ((yk_object *)PTR(v))->kind != 0 && ((yk_object *)PTR(v))->kind != 3 &&
       ((yk_object *)PTR(v))->kind != 4))
    items = iterable_items(v);
  else {
    /* array-like: length, then each index */
    double n = to_number(yk_get(v, ascii("length")));
    items = new_array(4);
    for (uint32_t i = 0; n == n && i < n; i++) push(items, yk_get(v, yk_number(i)));
  }
  if (argc > 1 && is_closure(argv[1]))
    for (uint32_t i = 0; i < items->len; i++) {
      yk args[2] = {items->items[i], yk_number(i)};
      items->items[i] = call_value(argv[1], YK_UNDEFINED, 2, args);
    }
  return BOX(T_ARRAY, items);
}
static yk builtin_array_is_array(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_bool(argc > 0 && is_array(argv[0]));
}

static yk object_parts(yk v, int which) {
  yk_array *r = new_array(4);
  /* An object's own enumerable keys: a plain one's, or a Map's, Set's or Date's set on it (not a
     buffer's or typed array's, whose elements are keys of their own). */
  if (is_object(v) && !(((yk_object *)PTR(v))->kind >= 6 && ((yk_object *)PTR(v))->kind <= 8)) {
    yk_object *o = (yk_object *)PTR(v);
    yk_array *keys = enumerable_keys(o);
    for (uint32_t i = 0; i < keys->len; i++) {
      yk value;
      own_get(o, keys->items[i], &value);
      value = resolve_slot(value, v);
      yk pair[2] = {keys->items[i], value};
      push(r, which == 0 ? keys->items[i] : which == 1 ? value : yk_array_of(2, pair));
    }
  } else if (is_array(v) || is_string(v)) {
    uint32_t n = is_array(v) ? arr(v)->len : str(v)->len;
    for (uint32_t i = 0; i < n; i++) {
      if (is_array(v) && array_hole(arr(v), i)) continue;
      yk k = to_string(yk_number(i)), value = yk_get(v, yk_number(i));
      yk pair[2] = {k, value};
      push(r, which == 0 ? k : which == 1 ? value : yk_array_of(2, pair));
    }
  } else if (is_nullish(v))
    type_error("Cannot convert undefined or null to object");
  return BOX(T_ARRAY, r);
}
static yk builtin_object_keys(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return object_parts(argc > 0 ? argv[0] : YK_UNDEFINED, 0); }
static yk builtin_object_values(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return object_parts(argc > 0 ? argv[0] : YK_UNDEFINED, 1); }
static yk builtin_object_entries(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return object_parts(argc > 0 ? argv[0] : YK_UNDEFINED, 2); }
static yk builtin_object_assign(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk target = argc > 0 ? argv[0] : YK_UNDEFINED;
  for (uint64_t i = 1; i < argc; i++) {
    if (is_nullish(argv[i])) continue;
    yk_array *entries = arr(object_parts(argv[i], 2));
    for (uint32_t j = 0; j < entries->len; j++)
      yk_set(target, arr(entries->items[j])->items[0], arr(entries->items[j])->items[1]);
  }
  return target;
}
static yk builtin_identity(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return argc > 0 ? argv[0] : YK_UNDEFINED; }
static yk builtin_object(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return argc > 0 && is_reference(argv[0]) ? argv[0] : yk_object_of(0, NULL, NULL);
}
static yk builtin_map(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk m = new_collection(1);
  if (argc > 0 && !is_nullish(argv[0])) {
    yk_array *items = iterable_items(argv[0]);
    for (uint32_t i = 0; i < items->len; i++) {
      yk pair = items->items[i];
      collection_put((yk_object *)PTR(m), yk_get(pair, yk_number(0)), yk_get(pair, yk_number(1)));
    }
  }
  return m;
}
static yk builtin_set(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk set = new_collection(2);
  if (argc > 0 && !is_nullish(argv[0])) {
    yk_array *items = iterable_items(argv[0]);
    for (uint32_t i = 0; i < items->len; i++) collection_put((yk_object *)PTR(set), items->items[i], YK_UNDEFINED);
  }
  return set;
}

/* A built-in function's name (its `name` property). */
static yk named(yk f, yk name) {
  if (is_closure(f)) ((yk_closure *)PTR(f))->fname = name;
  else own_set(own_props(f), ascii("name"), name);
  return f;
}
/* A function's name and length as its code gives them (the lowering's, at each closure made). */
yk yk_closure_meta(yk f, const char *name, uint64_t n, int64_t length) {
  yk_closure *c = (yk_closure *)PTR(f);
  if (name != NULL) c->fname = yk_string_utf8(name, n);
  c->flen = (int32_t)length;
  return f;
}
static void name_method(yk f, yk key, const char *prefix);
/* An object literal's method or anonymous function value: named by its key (NamedEvaluation). */
yk yk_name_method(yk f, yk key) {
  name_method(f, to_property_key(key), NULL);
  return f;
}
/* A class's name, as its declaration (or binding) gives it. */
yk yk_class_name(yk f, const char *name, uint64_t n) {
  ((yk_closure *)PTR(f))->fname = yk_string_utf8(name, n);
  return f;
}
/* A method's name, from its key, unless its code named it (a symbol key: "[description]"). */
static void name_method(yk f, yk key, const char *prefix) {
  if (!is_closure(f) || ((yk_closure *)PTR(f))->fname != 0) return;
  yk n = key;
  if (is_symbol(key)) {
    yk d = ((yk_symbol *)PTR(key))->description;
    n = d == YK_UNDEFINED ? ascii("") : concat(str(concat(str(ascii("[")), str(d))), str(ascii("]")));
  }
  if (prefix != NULL) n = concat(str(ascii(prefix)), str(to_string(n)));
  ((yk_closure *)PTR(f))->fname = to_string(n);
}
static yk with_methods(yk_code code, int n, const char *const *names, const yk_code *codes) {
  yk f = code != NULL ? yk_closure_new(code, 0, 0, NULL) : yk_object_of(0, NULL, NULL);
  for (int i = 0; i < n; i++) yk_set(f, ascii(names[i]), named(yk_closure_new(codes[i], 0, 0, NULL), ascii(names[i])));
  return f;
}

/* --- RegExp: a matcher compiled from the literal (regex.ts), driven as ECMAScript drives one --- */

static int is_regexp(yk v) { return is_object(v) && ((yk_object *)PTR(v))->kind == 3; }

/* A regex literal's object: source, flags, the matcher (s, start, sticky) → indexes or null, names. */
yk yk_regexp_new(yk source, yk flags, yk matcher, yk names) {
  yk key = ascii("lastIndex"), zero = yk_number(0);
  yk v = yk_object_of(1, &key, &zero);
  yk_object *o = (yk_object *)PTR(v);
  o->kind = 3;
  o->regex = alloc(4 * sizeof(yk));
  o->regex[0] = source;
  o->regex[1] = flags;
  o->regex[2] = matcher;
  o->regex[3] = names;
  return v;
}

static int has_flag(yk re, char f) {
  yk_string *fl = str(((yk_object *)PTR(re))->regex[1]);
  for (uint32_t i = 0; i < fl->len; i++)
    if (fl->units[i] == (uint16_t)f) return 1;
  return 0;
}

static yk substring(yk_string *s, uint32_t a, uint32_t b) {
  yk_string *r = new_string(b > a ? b - a : 0);
  if (b > a) memcpy(r->units, s->units + a, (size_t)(b - a) * 2);
  return string_of(r);
}

/* The matcher at `start` (only there when sticky): the indexes array, or null. */
static yk run_matcher(yk re, yk s, uint32_t start, int sticky) {
  yk args[3] = {s, yk_number(start), yk_bool(sticky)};
  return call_value(((yk_object *)PTR(re))->regex[2], YK_UNDEFINED, 3, args);
}

/* The match array exec gives: the matched text and the groups, with index, input, groups. */
static yk match_array(yk re, yk s, yk idx) {
  yk_array *ix = arr(idx);
  yk_array *r = new_array(ix->len / 2);
  for (uint32_t g = 0; g < ix->len / 2; g++) {
    double a = num(ix->items[2 * g]), b = num(ix->items[2 * g + 1]);
    push(r, a < 0 ? YK_UNDEFINED : substring(str(s), (uint32_t)a, (uint32_t)b));
  }
  yk v = BOX(T_ARRAY, r);
  yk_set(v, ascii("index"), ix->items[0]);
  yk_set(v, ascii("input"), s);
  yk names = ((yk_object *)PTR(re))->regex[3];
  yk groups = YK_UNDEFINED;
  for (uint32_t g = 0; g < arr(names)->len; g++)
    if (arr(names)->items[g] != YK_UNDEFINED) {
      if (groups == YK_UNDEFINED) groups = yk_object_of(0, NULL, NULL);
      yk_set(groups, arr(names)->items[g], r->items[g + 1]);
    }
  yk_set(v, ascii("groups"), groups);
  return v;
}

/* RegExpBuiltinExec. */
static yk regexp_exec(yk re, yk s) {
  s = to_string(s);
  int global = has_flag(re, 'g'), sticky = has_flag(re, 'y');
  uint32_t start = 0;
  if (global || sticky) {
    double li = to_number(yk_get(re, ascii("lastIndex")));
    li = li != li || li < 0 ? 0 : trunc(li);
    if (li > str(s)->len) {
      yk_set(re, ascii("lastIndex"), yk_number(0));
      return YK_NULL;
    }
    start = (uint32_t)li;
  }
  yk idx = run_matcher(re, s, start, sticky);
  if (idx == YK_NULL) {
    if (global || sticky) yk_set(re, ascii("lastIndex"), yk_number(0));
    return YK_NULL;
  }
  if (global || sticky) yk_set(re, ascii("lastIndex"), arr(idx)->items[1]);
  return match_array(re, s, idx);
}

/* The index after i, by code point when the regex is unicode. */
static uint32_t advance(yk_string *s, uint32_t i, int unicode) {
  if (unicode && i + 1 < s->len && s->units[i] >= 0xD800 && s->units[i] <= 0xDBFF && s->units[i + 1] >= 0xDC00 &&
      s->units[i + 1] <= 0xDFFF)
    return i + 2;
  return i + 1;
}

/* GetSubstitution: $$, $&, $`, $', $n, $nn, $<name> in a replacement string. */
static yk substitute(yk_string *rep, yk m) {
  yk_array *caps = arr(m);
  yk_string *input = str(yk_get(m, ascii("input")));
  uint32_t pos = (uint32_t)num(yk_get(m, ascii("index")));
  yk_string *matched = str(caps->items[0]);
  yk groups = yk_get(m, ascii("groups"));
  yk out = ascii("");
  for (uint32_t i = 0; i < rep->len; i++) {
    uint16_t c = rep->units[i];
    if (c != '$' || i + 1 >= rep->len) {
      yk_string *one = new_string(1);
      one->units[0] = c;
      out = concat(str(out), one);
      continue;
    }
    uint16_t d = rep->units[i + 1];
    if (d == '$') out = concat(str(out), str(ascii("$"))), i++;
    else if (d == '&') out = concat(str(out), matched), i++;
    else if (d == '`') out = concat(str(out), str(substring(input, 0, pos))), i++;
    else if (d == '\'') out = concat(str(out), str(substring(input, pos + matched->len, input->len))), i++;
    else if (d >= '0' && d <= '9') {
      uint32_t n = d - '0', used = 1;
      if (i + 2 < rep->len && rep->units[i + 2] >= '0' && rep->units[i + 2] <= '9') {
        uint32_t nn = n * 10 + (rep->units[i + 2] - '0');
        if (nn >= 1 && nn < caps->len) n = nn, used = 2;
      }
      if (n >= 1 && n < caps->len) {
        if (caps->items[n] != YK_UNDEFINED) out = concat(str(out), str(caps->items[n]));
        i += used;
      } else
        out = concat(str(out), str(ascii("$")));
    } else if (d == '<' && groups != YK_UNDEFINED) {
      uint32_t close = i + 2;
      while (close < rep->len && rep->units[close] != '>') close++;
      if (close >= rep->len) {
        out = concat(str(out), str(ascii("$")));
        continue;
      }
      yk v = yk_get(groups, substring(rep, i + 2, close));
      if (v != YK_UNDEFINED) out = concat(str(out), str(to_string(v)));
      i = close;
    } else
      out = concat(str(out), str(ascii("$")));
  }
  return out;
}

/* The replacement for one match: a function's result, or the substituted string. */
static yk replacement(yk repl, yk m) {
  if (!is_closure(repl)) return substitute(str(to_string(repl)), m);
  yk_array *caps = arr(m);
  yk groups = yk_get(m, ascii("groups"));
  yk_array *args = new_array(caps->len + 3);
  for (uint32_t i = 0; i < caps->len; i++) push(args, caps->items[i]);
  push(args, yk_get(m, ascii("index")));
  push(args, yk_get(m, ascii("input")));
  if (groups != YK_UNDEFINED) push(args, groups);
  return to_string(call_value(repl, YK_UNDEFINED, args->len, args->items));
}

/* A match of a plain string at a position, as an exec result (for replace with a string pattern). */
static yk string_match(yk s, yk_string *pat, uint32_t at) {
  yk_array *r = new_array(1);
  push(r, string_of(pat));
  yk v = BOX(T_ARRAY, r);
  yk_set(v, ascii("index"), yk_number(at));
  yk_set(v, ascii("input"), s);
  yk_set(v, ascii("groups"), YK_UNDEFINED);
  return v;
}

static int64_t find_from(yk_string *s, yk_string *t, uint32_t from) {
  for (uint32_t i = from; i + t->len <= s->len; i++)
    if (memcmp(s->units + i, t->units, (size_t)t->len * 2) == 0) return i;
  return -1;
}

/* The string methods that take a pattern: 1 when name is one, with its result in *out. */
static int string_pattern_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  yk a0 = argc > 0 ? argv[0] : YK_UNDEFINED, a1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  yk_string *s = str(recv);
  int replace_all = key_is(key, "replaceAll");
  if (key_is(key, "replace") || replace_all) {
    if (is_regexp(a0)) {
      int global = has_flag(a0, 'g');
      if (replace_all && !global) type_error("replaceAll must be called with a global RegExp");
      if (global) yk_set(a0, ascii("lastIndex"), yk_number(0));
      yk acc = ascii("");
      uint32_t last = 0;
      for (;;) {
        yk m = regexp_exec(a0, recv);
        if (m == YK_NULL) break;
        uint32_t at = (uint32_t)num(yk_get(m, ascii("index")));
        uint32_t len = str(arr(m)->items[0])->len;
        if (at >= last) {
          acc = concat(str(acc), str(substring(s, last, at)));
          acc = concat(str(acc), str(replacement(a1, m)));
          last = at + len;
        }
        if (!global) break;
        if (len == 0) {
          double li = num(yk_get(a0, ascii("lastIndex")));
          yk_set(a0, ascii("lastIndex"), yk_number(advance(s, (uint32_t)li, has_flag(a0, 'u'))));
        }
      }
      *out = concat(str(acc), str(substring(s, last, s->len)));
      return 1;
    }
    yk_string *pat = str(to_string(a0));
    yk acc = ascii("");
    uint32_t last = 0;
    int64_t at = find_from(s, pat, 0);
    while (at >= 0) {
      acc = concat(str(acc), str(substring(s, last, (uint32_t)at)));
      acc = concat(str(acc), str(replacement(a1, string_match(recv, pat, (uint32_t)at))));
      last = (uint32_t)at + pat->len;
      if (!replace_all) break;
      at = pat->len == 0 ? (at + 1 <= s->len ? find_from(s, pat, (uint32_t)at + 1) : -1) : find_from(s, pat, last);
    }
    *out = concat(str(acc), str(substring(s, last, s->len)));
    return 1;
  }
  if (key_is(key, "match") || key_is(key, "matchAll") || key_is(key, "search")) {
    if (!is_regexp(a0)) type_error("a pattern that is not a regex literal (a dynamic RegExp) is not in the native runtime");
    if (key_is(key, "search")) {
      yk saved = yk_get(a0, ascii("lastIndex"));
      yk idx = run_matcher(a0, recv, 0, has_flag(a0, 'y'));
      yk_set(a0, ascii("lastIndex"), saved);
      *out = idx == YK_NULL ? yk_number(-1) : arr(idx)->items[0];
      return 1;
    }
    int all = key_is(key, "matchAll");
    if (all && !has_flag(a0, 'g')) type_error("matchAll must be called with a global RegExp");
    if (!all && !has_flag(a0, 'g')) {
      *out = regexp_exec(a0, recv);
      return 1;
    }
    yk_set(a0, ascii("lastIndex"), yk_number(0));
    yk_array *r = new_array(4);
    for (;;) {
      yk m = regexp_exec(a0, recv);
      if (m == YK_NULL) break;
      push(r, all ? m : arr(m)->items[0]);
      if (str(arr(m)->items[0])->len == 0) {
        double li = num(yk_get(a0, ascii("lastIndex")));
        yk_set(a0, ascii("lastIndex"), yk_number(advance(s, (uint32_t)li, has_flag(a0, 'u'))));
      }
    }
    *out = !all && r->len == 0 ? YK_NULL : BOX(T_ARRAY, r);
    return 1;
  }
  if (key_is(key, "split") && is_regexp(a0)) {
    /* RegExp.prototype[@@split]: sticky matches at each position, with the captures between. */
    uint32_t limit = a1 == YK_UNDEFINED ? 0xFFFFFFFFu : to_uint32(a1);
    yk_array *r = new_array(4);
    if (limit == 0) return *out = BOX(T_ARRAY, r), 1;
    if (s->len == 0) {
      if (run_matcher(a0, recv, 0, 1) == YK_NULL) push(r, recv);
      return *out = BOX(T_ARRAY, r), 1;
    }
    int unicode = has_flag(a0, 'u');
    uint32_t p = 0, q = 0;
    while (q < s->len) {
      yk idx = run_matcher(a0, recv, q, 1);
      if (idx == YK_NULL) {
        q = advance(s, q, unicode);
        continue;
      }
      uint32_t e = (uint32_t)num(arr(idx)->items[1]);
      if (e > s->len) e = s->len;
      if (e == p) {
        q = advance(s, q, unicode);
        continue;
      }
      push(r, substring(s, p, q));
      if (r->len == limit) return *out = BOX(T_ARRAY, r), 1;
      for (uint32_t g = 1; g < arr(idx)->len / 2; g++) {
        double a = num(arr(idx)->items[2 * g]), b = num(arr(idx)->items[2 * g + 1]);
        push(r, a < 0 ? YK_UNDEFINED : substring(s, (uint32_t)a, (uint32_t)b));
        if (r->len == limit) return *out = BOX(T_ARRAY, r), 1;
      }
      p = e;
      q = p;
    }
    push(r, substring(s, p, s->len));
    return *out = BOX(T_ARRAY, r), 1;
  }
  return 0;
}

/* --- the global functions, as values --- */

static int is_generator_return(yk v);
/* __yakccTry(body, handler, finalizer): a try statement, as the TypeScript lowering's runtime has it. */
static yk builtin_try(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk body = argv[0], handler_fn = argc > 1 ? argv[1] : YK_UNDEFINED, fin = argc > 2 ? argv[2] : YK_UNDEFINED;
  yk r;
  int threw = protected_call(body, 0, NULL, &r);
  if (threw && is_closure(handler_fn) && !is_generator_return(r)) {
    yk exc = r;
    threw = protected_call(handler_fn, 1, &exc, &r);
  }
  if (is_closure(fin)) {
    yk done = call_value(fin, YK_UNDEFINED, 0, NULL);
    if (is_array(done) && arr(done)->len > 0 && strict_equal(arr(done)->items[0], yk_number(1))) return done;
  }
  if (threw) yk_throw(r);
  return r;
}

static yk builtin_error_named(const char *name, uint64_t argc, const yk *argv) {
  return make_error(name, argc > 0 && argv[0] != YK_UNDEFINED ? to_string(argv[0]) : ascii(""));
}
static yk builtin_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("Error", argc, argv); }
static yk builtin_type_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("TypeError", argc, argv); }
static yk builtin_range_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("RangeError", argc, argv); }
static yk builtin_syntax_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("SyntaxError", argc, argv); }
static yk builtin_eval_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("EvalError", argc, argv); }
static yk builtin_reference_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("ReferenceError", argc, argv); }
static yk builtin_uri_error(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return builtin_error_named("URIError", argc, argv); }
/* AggregateError(errors, message): an Error whose errors are the iterable's values. */
static yk builtin_aggregate_error(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk e = builtin_error_named("AggregateError", argc > 1 ? 1 : 0, argv + 1);
  yk_array *items = iterable_items(argc > 0 ? argv[0] : YK_UNDEFINED);
  own_set((yk_object *)PTR(e), ascii("errors"), BOX(T_ARRAY, items));
  return e;
}

/* --- WeakMap, WeakSet, WeakRef, FinalizationRegistry (#1331) ---
   A weak collection is a Map or Set whose prototype is its own intrinsic one: the collector keeps
   whatever is reachable, so holding the keys strongly only keeps more alive, which nothing can
   observe (no WeakRef here is ever cleared, no finalization callback ever runs). */
/* A WeakMap's or WeakSet's ext: marks it weak (a Map's and a Set's is NULL). */
static int weak_marker;
static yk weak_collection(int kind, int which, uint64_t argc, const yk *argv) {
  yk c = new_collection(kind);
  ((yk_object *)PTR(c))->proto = intrinsic_proto(which);
  ((yk_object *)PTR(c))->ext = &weak_marker;
  if (argc > 0 && !is_nullish(argv[0])) {
    yk_array *items = iterable_items(argv[0]);
    for (uint32_t i = 0; i < items->len; i++) {
      yk e = items->items[i];
      if (kind == 1) collection_put((yk_object *)PTR(c), yk_get(e, yk_number(0)), yk_get(e, yk_number(1)));
      else collection_put((yk_object *)PTR(c), e, YK_UNDEFINED);
    }
  }
  return c;
}
static yk builtin_weak_map(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return weak_collection(1, I_WEAKMAP, argc, argv); }
static yk builtin_weak_set(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return weak_collection(2, I_WEAKSET, argc, argv); }
static yk builtin_weak_ref(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk target = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (!is_object(target) && !is_closure(target) && !is_array(target) && !is_symbol(target))
    type_error("WeakRef: invalid target");
  yk r = yk_object_of(0, NULL, NULL);
  ((yk_object *)PTR(r))->kind = 11;
  yk *box = alloc(sizeof(yk));
  *box = target;
  ((yk_object *)PTR(r))->ext = box;
  return r;
}
static yk builtin_finalization_registry(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  if (argc == 0 || !is_closure(argv[0])) type_error("FinalizationRegistry: cleanup must be callable");
  yk r = yk_object_of(0, NULL, NULL);
  ((yk_object *)PTR(r))->kind = 12;
  return r;
}

/* --- Date (ECMA-262 21.4): a time value, milliseconds since the epoch (NaN when invalid). Local time
   is UTC here (offset 0). --- */
static const double ms_per_day = 86400000.0;
static double date_value(yk d) { return *(double *)((yk_object *)PTR(d))->ext; }
static yk date_new(double t) {
  yk r = yk_object_of(0, NULL, NULL);
  ((yk_object *)PTR(r))->kind = 10;
  double *box = alloc(sizeof(double));
  *box = t;
  ((yk_object *)PTR(r))->ext = box;
  return r;
}
static int is_date(yk v) { return is_object(v) && ((yk_object *)PTR(v))->kind == 10; }
static double time_clip(double t) {
  if (!isfinite(t) || fabs(t) > 8.64e15) return NAN;
  return trunc(t) + 0.0;
}
/* Days from the epoch of a civil date (proleptic Gregorian), and back (H. Hinnant's algorithms). */
static double days_from_civil(double y, double m, double d) {
  y -= m <= 2;
  double era = floor(y / 400);
  double yoe = y - era * 400;
  double doy = floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  double doe = yoe * 365 + floor(yoe / 4) - floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
static void civil_from_days(double z, double *y, double *m, double *d) {
  z += 719468;
  double era = floor(z / 146097);
  double doe = z - era * 146097;
  double yoe = floor((doe - floor(doe / 1460) + floor(doe / 36524) - floor(doe / 146096)) / 365);
  double yy = yoe + era * 400;
  double doy = doe - (365 * yoe + floor(yoe / 4) - floor(yoe / 100));
  double mp = floor((5 * doy + 2) / 153);
  *d = doy - floor((153 * mp + 2) / 5) + 1;
  *m = mp < 10 ? mp + 3 : mp - 9;
  *y = yy + (*m <= 2);
}
/* MakeDay + MakeTime + MakeDate: a time value from its fields (month from 0, as JavaScript's). */
static double make_date(double y, double mon, double day, double h, double mi, double sec, double ms) {
  double fields[7] = {y, mon, day, h, mi, sec, ms};
  for (int i = 0; i < 7; i++)
    if (!isfinite(fields[i])) return NAN;
  y = trunc(y) + floor(trunc(mon) / 12);
  double m = fmod(trunc(mon), 12);
  if (m < 0) m += 12;
  double days = days_from_civil(y, m + 1, 1) + trunc(day) - 1;
  return days * ms_per_day + trunc(h) * 3600000.0 + trunc(mi) * 60000.0 + trunc(sec) * 1000.0 + trunc(ms);
}
static double date_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)(ts.tv_nsec / 1000000);
}
/* Date.parse: the ISO 8601 forms ECMA-262 21.4.1.32 defines (a date alone is UTC; a date-time with no
   offset is local, which is UTC here); anything else is NaN. */
static double date_parse(yk v) {
  yk_string *s = str(to_string(v));
  uint32_t i = 0, n = s->len;
  int sign = 1, ydigits = 4;
  if (i < n && (s->units[i] == '+' || s->units[i] == '-')) {
    sign = s->units[i] == '-' ? -1 : 1;
    ydigits = 6;
    i++;
  }
  double f[7] = {0, 0, 1, 0, 0, 0, 0};
  int lens[7] = {ydigits, 2, 2, 2, 2, 2, 3};
  const char seps[7] = {0, '-', '-', 'T', ':', ':', '.'};
  int k = 0;
  for (; k < 7; k++) {
    if (k > 0) {
      if (i >= n || s->units[i] != (uint16_t)seps[k]) break;
      if (k == 3 && i + 1 >= n) return NAN;
      i++;
    }
    double x = 0;
    for (int j = 0; j < lens[k]; j++) {
      if (i >= n || s->units[i] < '0' || s->units[i] > '9') return NAN;
      x = x * 10 + (s->units[i++] - '0');
    }
    f[k] = x;
    if (k == 6) {
      while (i < n && s->units[i] >= '0' && s->units[i] <= '9') i++; /* more digits: ignored */
      k++;
      break;
    }
  }
  if (k == 4) return NAN; /* THH without :mm */
  if (ydigits == 6 && sign == -1 && f[0] == 0) return NAN;
  double offset = 0;
  int has_offset = 0;
  if (i < n && s->units[i] == 'Z') {
    has_offset = 1;
    i++;
  } else if (i < n && (s->units[i] == '+' || s->units[i] == '-') && k > 3) {
    int os = s->units[i] == '-' ? -1 : 1;
    i++;
    double hh = 0, mm = 0;
    for (int j = 0; j < 2; j++) {
      if (i >= n || s->units[i] < '0' || s->units[i] > '9') return NAN;
      hh = hh * 10 + (s->units[i++] - '0');
    }
    if (i >= n || s->units[i] != ':') return NAN;
    i++;
    for (int j = 0; j < 2; j++) {
      if (i >= n || s->units[i] < '0' || s->units[i] > '9') return NAN;
      mm = mm * 10 + (s->units[i++] - '0');
    }
    offset = os * (hh * 60 + mm) * 60000.0;
    has_offset = 1;
  }
  if (i != n) return NAN;
  if (f[1] < 1 || f[1] > 12 || f[2] < 1 || f[2] > 31 || f[3] > 24 || f[4] > 59 || f[5] > 59) return NAN;
  if (f[3] == 24 && (f[4] != 0 || f[5] != 0 || f[6] != 0)) return NAN;
  (void)has_offset;
  double t = make_date(sign * f[0], f[1] - 1, f[2], f[3], f[4], f[5], f[6]) - offset;
  return time_clip(t);
}
static yk builtin_date(void *c, yk s, uint64_t argc, const yk *argv);
/* new Date(…): now; a time value; a date's; a string parsed; or the fields (local, so UTC here). */
static yk date_construct(uint64_t argc, const yk *argv) {
  if (argc == 0) return date_new(date_now());
  if (argc == 1) {
    yk v = argv[0];
    if (is_date(v)) return date_new(date_value(v));
    v = to_primitive(v);
    if (is_string(v)) return date_new(date_parse(v));
    return date_new(time_clip(to_number(v)));
  }
  double f[7] = {0, 0, 1, 0, 0, 0, 0};
  for (uint64_t i = 0; i < argc && i < 7; i++) f[i] = to_number(argv[i]);
  if (isfinite(f[0])) {
    double yi = trunc(f[0]);
    if (yi >= 0 && yi <= 99) f[0] = 1900 + yi;
  }
  return date_new(time_clip(make_date(f[0], f[1], f[2], f[3], f[4], f[5], f[6])));
}
static const char *const week_days[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *const month_names[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
/* A time value's fields: year, month (0-11), day, weekday, hours, minutes, seconds, milliseconds. */
static void date_fields(double t, double out[8]) {
  double day = floor(t / ms_per_day), in_day = t - day * ms_per_day;
  double y, m, d;
  civil_from_days(day, &y, &m, &d);
  out[0] = y, out[1] = m - 1, out[2] = d;
  double wd = fmod(day + 4, 7);
  out[3] = wd < 0 ? wd + 7 : wd + 0.0; /* fmod of a negative multiple is -0 */
  out[4] = floor(in_day / 3600000.0);
  out[5] = fmod(floor(in_day / 60000.0), 60);
  out[6] = fmod(floor(in_day / 1000.0), 60);
  out[7] = fmod(in_day, 1000);
}
static yk date_string(double t, int what) {
  if (t != t) return ascii("Invalid Date");
  double f[8];
  date_fields(t, f);
  char buf[96];
  char year[16];
  if (f[0] < 0) snprintf(year, sizeof year, "-%06.0f", -f[0]);
  else snprintf(year, sizeof year, "%04.0f", f[0]);
  if (what == 0) /* toString */
    snprintf(buf, sizeof buf, "%s %s %02.0f %s %02.0f:%02.0f:%02.0f GMT+0000 (Coordinated Universal Time)",
             week_days[(int)f[3]], month_names[(int)f[1]], f[2], year, f[4], f[5], f[6]);
  else if (what == 1) /* toDateString */
    snprintf(buf, sizeof buf, "%s %s %02.0f %s", week_days[(int)f[3]], month_names[(int)f[1]], f[2], year);
  else if (what == 2) /* toTimeString */
    snprintf(buf, sizeof buf, "%02.0f:%02.0f:%02.0f GMT+0000 (Coordinated Universal Time)", f[4], f[5], f[6]);
  else /* toUTCString */
    snprintf(buf, sizeof buf, "%s, %02.0f %s %s %02.0f:%02.0f:%02.0f GMT", week_days[(int)f[3]], f[2],
             month_names[(int)f[1]], year, f[4], f[5], f[6]);
  return ascii(buf);
}
static yk date_iso(double t) {
  if (t != t) range_error("Invalid time value");
  double f[8];
  date_fields(t, f);
  char buf[48], year[16];
  if (f[0] >= 0 && f[0] <= 9999) snprintf(year, sizeof year, "%04.0f", f[0]);
  else snprintf(year, sizeof year, "%c%06.0f", f[0] < 0 ? '-' : '+', fabs(f[0]));
  snprintf(buf, sizeof buf, "%s-%02.0f-%02.0fT%02.0f:%02.0f:%02.0f.%03.0fZ", year, f[1] + 1, f[2], f[4], f[5], f[6], f[7]);
  return ascii(buf);
}
/* A Date method by its key, or 0 when it is not one. */
static int date_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  double t = date_value(recv);
  if (key_is(key, "getTime") || key_is(key, "valueOf")) return *out = yk_number(t), 1;
  if (key_is(key, "toISOString")) return *out = date_iso(t), 1;
  if (key_is(key, "toJSON")) return *out = t != t ? YK_NULL : date_iso(t), 1;
  if (key_is(key, "toString") || key_is(key, "toLocaleString")) return *out = date_string(t, 0), 1;
  if (key_is(key, "toDateString") || key_is(key, "toLocaleDateString")) return *out = date_string(t, 1), 1;
  if (key_is(key, "toTimeString") || key_is(key, "toLocaleTimeString")) return *out = date_string(t, 2), 1;
  if (key_is(key, "toUTCString") || key_is(key, "toGMTString")) return *out = date_string(t, 3), 1;
  if (key_is(key, "getTimezoneOffset")) return *out = t != t ? yk_number(NAN) : yk_number(0), 1;
  static const char *const getters[] = {"FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"};
  if (is_string(key) && str(key)->len > 3 && str(key)->units[0] == 'g' && str(key)->units[1] == 'e' && str(key)->units[2] == 't') {
    yk_string *k = str(key);
    uint32_t from = 3;
    if (k->len > 6 && k->units[3] == 'U' && k->units[4] == 'T' && k->units[5] == 'C') from = 6;
    for (int g = 0; g < 8; g++) {
      size_t gl = strlen(getters[g]);
      if (k->len - from != gl) continue;
      int same = 1;
      for (size_t j = 0; j < gl; j++)
        if (k->units[from + j] != (uint16_t)getters[g][j]) same = 0;
      if (!same) continue;
      if (t != t) return *out = yk_number(NAN), 1;
      double f[8];
      date_fields(t, f);
      return *out = yk_number(f[g]), 1;
    }
    if (key_is(key, "getYear")) {
      if (t != t) return *out = yk_number(NAN), 1;
      double f[8];
      date_fields(t, f);
      return *out = yk_number(f[0] - 1900), 1;
    }
  }
  if (key_is(key, "setTime")) {
    double v = time_clip(to_number(argc > 0 ? argv[0] : YK_UNDEFINED));
    *(double *)((yk_object *)PTR(recv))->ext = v;
    return *out = yk_number(v), 1;
  }
  /* setFullYear … setMilliseconds (and the UTC forms: the same, local time being UTC). */
  static const char *const setters[] = {"FullYear", "Month", "Date", "Hours", "Minutes", "Seconds", "Milliseconds"};
  static const int field_of[] = {0, 1, 2, 4, 5, 6, 7};
  static const int arity[] = {3, 2, 1, 4, 3, 2, 1};
  if (is_string(key) && str(key)->len > 3 && str(key)->units[0] == 's' && str(key)->units[1] == 'e' && str(key)->units[2] == 't') {
    yk_string *k = str(key);
    uint32_t from = 3;
    if (k->len > 6 && k->units[3] == 'U' && k->units[4] == 'T' && k->units[5] == 'C') from = 6;
    for (int g = 0; g < 7; g++) {
      size_t gl = strlen(setters[g]);
      if (k->len - from != gl) continue;
      int same = 1;
      for (size_t j = 0; j < gl; j++)
        if (k->units[from + j] != (uint16_t)setters[g][j]) same = 0;
      if (!same) continue;
      double f[8];
      if (t != t) {
        if (g != 0) return *out = yk_number(NAN), 1;
        date_fields(0, f);
      } else
        date_fields(t, f);
      double fields[8] = {f[0], f[1], f[2], 0, f[4], f[5], f[6], f[7]};
      for (int a = 0; a < arity[g] && (uint64_t)a < argc; a++) {
        int idx = field_of[g] + a;
        if (idx == 3) idx = 4; /* after Date comes Hours */
        fields[idx] = to_number(argv[a]);
      }
      if (argc == 0) fields[field_of[g]] = NAN;
      double v = time_clip(make_date(fields[0], fields[1], fields[2], fields[4], fields[5], fields[6], fields[7]));
      *(double *)((yk_object *)PTR(recv))->ext = v;
      return *out = yk_number(v), 1;
    }
  }
  return 0;
}
static yk date_static_now(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s, (void)argc, (void)argv; return yk_number(date_now()); }
static yk date_static_parse(void *c, yk s, uint64_t argc, const yk *argv) { (void)c, (void)s; return yk_number(date_parse(argc > 0 ? argv[0] : YK_UNDEFINED)); }
static yk date_static_utc(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  double f[7] = {NAN, 0, 1, 0, 0, 0, 0};
  for (uint64_t i = 0; i < argc && i < 7; i++) f[i] = to_number(argv[i]);
  if (isfinite(f[0])) {
    double yi = trunc(f[0]);
    if (yi >= 0 && yi <= 99) f[0] = 1900 + yi;
  }
  return yk_number(time_clip(make_date(f[0], f[1], f[2], f[3], f[4], f[5], f[6])));
}
/* Date called as a function: the current time's string. */
static yk builtin_date(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s, (void)argc, (void)argv;
  return date_string(date_now(), 0);
}
#include "rx.h"
/* RegExp(pattern, flags): a RegExp's copy (its source, flags and matcher); a pattern given as a string
   (or a RegExp with other flags) compiled at run time (rx.h). */
static yk builtin_regexp(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk p = argc > 0 ? argv[0] : YK_UNDEFINED;
  yk fl = argc > 1 ? argv[1] : YK_UNDEFINED;
  if (is_regexp(p) && fl == YK_UNDEFINED) {
    yk_object *o = (yk_object *)PTR(p);
    return yk_regexp_new(o->regex[0], o->regex[1], o->regex[2], o->regex[3]);
  }
  yk source = is_regexp(p) ? ((yk_object *)PTR(p))->regex[0] : p == YK_UNDEFINED ? ascii("(?:)") : to_string(p);
  yk flags = fl == YK_UNDEFINED ? (is_regexp(p) ? ((yk_object *)PTR(p))->regex[1] : ascii("")) : to_string(fl);
  if (str(source)->len == 0) source = ascii("(?:)");
  yk matcher, names;
  rx_compile(source, flags, &matcher, &names);
  return yk_regexp_new(source, flags, matcher, names);
}

/* parseFloat: the longest prefix that is a StrDecimalLiteral, after leading white space. */
static double parse_float(yk_string *s) {
  uint32_t i = 0;
  while (i < s->len && is_space(s->units[i])) i++;
  char buf[400];
  uint32_t n = 0;
  while (i < s->len && n < sizeof buf - 1 && s->units[i] < 0x80) buf[n++] = (char)s->units[i++];
  buf[n] = 0;
  const char *p = buf;
  int neg = 0;
  if (*p == '+' || *p == '-') neg = *p++ == '-';
  if (strncmp(p, "Infinity", 8) == 0) return neg ? -INFINITY : INFINITY;
  const char *q = p;
  int digits = 0;
  while (*q >= '0' && *q <= '9') q++, digits++;
  if (*q == '.') {
    q++;
    while (*q >= '0' && *q <= '9') q++, digits++;
  }
  if (digits == 0) return NAN;
  if (*q == 'e' || *q == 'E') {
    const char *e = q + 1;
    if (*e == '+' || *e == '-') e++;
    if (*e >= '0' && *e <= '9') {
      while (*e >= '0' && *e <= '9') e++;
      q = e;
    }
  }
  char num_buf[400];
  size_t len = (size_t)(q - buf);
  memcpy(num_buf, buf, len);
  num_buf[len] = 0;
  return strtod(num_buf, NULL);
}

/* parseInt: an optional sign, the radix's digits (16 after 0x when the radix allows), else NaN. */
static double parse_int(yk_string *s, yk radix_v) {
  uint32_t i = 0;
  while (i < s->len && is_space(s->units[i])) i++;
  int neg = 0;
  if (i < s->len && (s->units[i] == '+' || s->units[i] == '-')) neg = s->units[i++] == '-';
  int32_t radix = to_int32(radix_v);
  int strip = 1;
  if (radix != 0) {
    if (radix < 2 || radix > 36) return NAN;
    if (radix != 16) strip = 0;
  } else
    radix = 10;
  if (strip && i + 1 < s->len && s->units[i] == '0' && (s->units[i + 1] == 'x' || s->units[i + 1] == 'X')) {
    i += 2;
    radix = 16;
  }
  double r = 0;
  int any = 0;
  for (; i < s->len; i++) {
    uint16_t c = s->units[i];
    int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'z' ? c - 'a' + 10 : c >= 'A' && c <= 'Z' ? c - 'A' + 10 : 99;
    if (d >= radix) break;
    r = r * radix + d;
    any = 1;
  }
  if (!any) return NAN;
  return neg ? -r : r;
}

static yk builtin_parse_float(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_number(parse_float(str(to_string(argc > 0 ? argv[0] : YK_UNDEFINED))));
}
static yk builtin_parse_int(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_number(parse_int(str(to_string(argc > 0 ? argv[0] : YK_UNDEFINED)), argc > 1 ? argv[1] : YK_UNDEFINED));
}
static yk builtin_is_nan(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  double d = to_number(argc > 0 ? argv[0] : YK_UNDEFINED);
  return yk_bool(d != d);
}
static yk builtin_is_finite(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  double d = to_number(argc > 0 ? argv[0] : YK_UNDEFINED);
  return yk_bool(d == d && !isinf(d));
}
/* Object.is: SameValue (NaN is NaN; 0 is not -0). */
static yk builtin_object_is(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk a = argc > 0 ? argv[0] : YK_UNDEFINED, b = argc > 1 ? argv[1] : YK_UNDEFINED;
  if (is_number(a) && is_number(b)) {
    double x = num(a), y = num(b);
    if (x != x && y != y) return YK_TRUE;
    if (x == 0 && y == 0) return yk_bool((1 / x < 0) == (1 / y < 0));
    return yk_bool(x == y);
  }
  return yk_bool(strict_equal(a, b));
}
/* Number.isFinite, isInteger, isSafeInteger and isNaN: false for anything but a number. */
static yk builtin_number_is_finite(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc == 0 || !is_number(argv[0])) return YK_FALSE;
  double d = num(argv[0]);
  return yk_bool(d == d && !isinf(d));
}
static yk builtin_number_is_integer(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc == 0 || !is_number(argv[0])) return YK_FALSE;
  double d = num(argv[0]);
  return yk_bool(d == d && !isinf(d) && trunc(d) == d);
}
static yk builtin_number_is_safe_integer(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc == 0 || !is_number(argv[0])) return YK_FALSE;
  double d = num(argv[0]);
  return yk_bool(d == d && !isinf(d) && trunc(d) == d && fabs(d) <= 9007199254740991.0);
}
static yk builtin_number_is_nan(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_bool(argc > 0 && is_number(argv[0]) && num(argv[0]) != num(argv[0]));
}
/* Array(n) and new Array(n): n holes, read as undefined; Array(a, b, …): those elements. */
static yk builtin_array(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc == 1 && is_number(argv[0])) {
    double d = num(argv[0]);
    if (d < 0 || d > 4294967295.0 || d != floor(d)) {
      fprintf(stderr, "RangeError: Invalid array length\n");
      exit(70);
    }
    yk_array *a = new_array((uint32_t)d);
    for (uint32_t i = 0; i < (uint32_t)d; i++) push(a, YK_UNDEFINED);
    for (uint32_t i = 0; i < (uint32_t)d; i++) array_mark_hole(a, i, 1);
    return BOX(T_ARRAY, a);
  }
  return yk_array_of(argc, argv);
}

/* --- case mapping (String.prototype.toUpperCase / toLowerCase): Unicode's full mappings, as Node
   gives them (case.h, generated from Node), and the final sigma rule (a Σ ending a word is ς). --- */
#include "case.h"
static const case_map *case_find(const case_map *table, int n, uint32_t cp) {
  int lo = 0, hi = n - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (table[mid].cp == cp) return &table[mid];
    if (table[mid].cp < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return NULL;
}
static uint32_t code_point_at(const yk_string *s, uint32_t i, uint32_t *width) {
  uint16_t c = s->units[i];
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s->len && s->units[i + 1] >= 0xDC00 && s->units[i + 1] <= 0xDFFF) {
    *width = 2;
    return 0x10000 + ((uint32_t)(c - 0xD800) << 10) + (s->units[i + 1] - 0xDC00);
  }
  *width = 1;
  return c;
}
/* Whether a code point is cased or case-ignorable enough for the final sigma rule: a letter that
   has a case mapping (approximated by the tables), and not a case-ignorable mark. */
static int is_cased(uint32_t cp) {
  return case_find(upper_map, N_UPPER, cp) != NULL || case_find(lower_map, N_LOWER, cp) != NULL;
}
static yk case_convert(yk v, int upper) {
  yk_string *s = str(v);
  uint16_t *out = scratch(((size_t)s->len * 3 + 2) * sizeof(uint16_t));
  uint32_t n = 0;
  for (uint32_t i = 0; i < s->len;) {
    uint32_t w, cp = code_point_at(s, i, &w);
    if (!upper && cp == 0x3A3) {
      /* Final_Sigma: preceded by a cased letter and not followed by one (skipping ignorables). */
      int before = 0, after = 0;
      for (int64_t j = (int64_t)i - 1; j >= 0; j--) {
        uint16_t u = s->units[j];
        if (u == 0x27 || u == 0xAD || u == 0x2019 || (u >= 0x300 && u <= 0x36F)) continue;
        before = is_cased(u);
        break;
      }
      for (uint32_t j = i + 1; j < s->len; j++) {
        uint16_t u = s->units[j];
        if (u == 0x27 || u == 0xAD || u == 0x2019 || (u >= 0x300 && u <= 0x36F)) continue;
        after = is_cased(u);
        break;
      }
      out[n++] = before && !after ? 0x3C2 : 0x3C3;
      i += w;
      continue;
    }
    const case_map *m = upper ? case_find(upper_map, N_UPPER, cp) : case_find(lower_map, N_LOWER, cp);
    if (m != NULL)
      for (int k = 0; k < m->n; k++) out[n++] = m->to[k];
    else
      for (uint32_t k = 0; k < w; k++) out[n++] = s->units[i + k];
    i += w;
  }
  yk_string *r = new_string(n);
  memcpy(r->units, out, (size_t)n * 2);
  free(out);
  return string_of(r);
}

/* --- URI handling (ECMA-262 19.2.6) and the legacy escape/unescape (B.2.1) --- */
static _Noreturn void uri_error(void) {
  yk_throw(make_error("URIError", ascii("URI malformed")));
}
static int in_set(uint16_t c, const char *set) {
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return 1;
  return c < 128 && c != 0 && strchr(set, (char)c) != NULL;
}
/* Encode: each code unit outside the unescaped set as the %XX bytes of its code point's UTF-8. */
static yk uri_encode(yk v, const char *unescaped) {
  yk_string *s = str(to_string(v));
  yk_array *parts = new_array(4);
  uint16_t *out = scratch(((size_t)s->len * 12 + 2) * sizeof(uint16_t));
  uint32_t n = 0;
  static const char hex[] = "0123456789ABCDEF";
  for (uint32_t i = 0; i < s->len; i++) {
    uint16_t c = s->units[i];
    if (in_set(c, unescaped)) {
      out[n++] = c;
      continue;
    }
    uint32_t cp = c;
    if (c >= 0xDC00 && c <= 0xDFFF) uri_error();
    if (c >= 0xD800 && c <= 0xDBFF) {
      if (i + 1 >= s->len || s->units[i + 1] < 0xDC00 || s->units[i + 1] > 0xDFFF) uri_error();
      cp = 0x10000 + ((c - 0xD800) << 10) + (s->units[++i] - 0xDC00);
    }
    uint8_t b[4];
    int k;
    if (cp < 0x80) b[0] = (uint8_t)cp, k = 1;
    else if (cp < 0x800) b[0] = (uint8_t)(0xC0 | cp >> 6), b[1] = (uint8_t)(0x80 | (cp & 63)), k = 2;
    else if (cp < 0x10000)
      b[0] = (uint8_t)(0xE0 | cp >> 12), b[1] = (uint8_t)(0x80 | ((cp >> 6) & 63)), b[2] = (uint8_t)(0x80 | (cp & 63)), k = 3;
    else
      b[0] = (uint8_t)(0xF0 | cp >> 18), b[1] = (uint8_t)(0x80 | ((cp >> 12) & 63)),
      b[2] = (uint8_t)(0x80 | ((cp >> 6) & 63)), b[3] = (uint8_t)(0x80 | (cp & 63)), k = 4;
    for (int j = 0; j < k; j++) {
      out[n++] = '%';
      out[n++] = (uint16_t)hex[b[j] >> 4];
      out[n++] = (uint16_t)hex[b[j] & 15];
    }
  }
  (void)parts;
  yk_string *r = new_string(n);
  memcpy(r->units, out, (size_t)n * 2);
  free(out);
  return string_of(r);
}
static int hex_value(uint16_t c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
/* Decode: each %XX… as the UTF-8 it is (a reserved character's escape kept as it is). */
static yk uri_decode(yk v, const char *reserved) {
  yk_string *s = str(to_string(v));
  uint16_t *out = scratch(((size_t)s->len + 2) * sizeof(uint16_t));
  uint32_t n = 0;
  for (uint32_t i = 0; i < s->len; i++) {
    uint16_t c = s->units[i];
    if (c != '%') {
      out[n++] = c;
      continue;
    }
    uint32_t start = i;
    if (i + 2 >= s->len || hex_value(s->units[i + 1]) < 0 || hex_value(s->units[i + 2]) < 0) uri_error();
    uint8_t b = (uint8_t)(hex_value(s->units[i + 1]) * 16 + hex_value(s->units[i + 2]));
    i += 2;
    if (b < 0x80) {
      if (reserved[0] != 0 && strchr(reserved, (char)b) != NULL && b != 0)
        for (uint32_t j = start; j <= i; j++) out[n++] = s->units[j];
      else
        out[n++] = b;
      continue;
    }
    int k = (b & 0xE0) == 0xC0 ? 2 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xF8) == 0xF0 ? 4 : 0;
    if (k == 0) uri_error();
    uint32_t cp = b & (0xFF >> (k + 1));
    for (int j = 1; j < k; j++) {
      if (i + 3 >= s->len || s->units[i + 1] != '%') uri_error();
      int h1 = hex_value(s->units[i + 2]), h2 = hex_value(s->units[i + 3]);
      if (h1 < 0 || h2 < 0) uri_error();
      uint8_t cb = (uint8_t)(h1 * 16 + h2);
      if ((cb & 0xC0) != 0x80) uri_error();
      cp = (cp << 6) | (cb & 63);
      i += 3;
    }
    static const uint32_t least[5] = {0, 0, 0x80, 0x800, 0x10000};
    if (cp < least[k] || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) uri_error();
    if (cp < 0x10000) out[n++] = (uint16_t)cp;
    else {
      cp -= 0x10000;
      out[n++] = (uint16_t)(0xD800 + (cp >> 10));
      out[n++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
    }
  }
  yk_string *r = new_string(n);
  memcpy(r->units, out, (size_t)n * 2);
  free(out);
  return string_of(r);
}
static yk builtin_encode_uri_component(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return uri_encode(argc > 0 ? argv[0] : YK_UNDEFINED, "-_.!~*'()");
}
static yk builtin_encode_uri(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return uri_encode(argc > 0 ? argv[0] : YK_UNDEFINED, "-_.!~*'();/?:@&=+$,#");
}
static yk builtin_decode_uri_component(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return uri_decode(argc > 0 ? argv[0] : YK_UNDEFINED, "");
}
static yk builtin_decode_uri(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return uri_decode(argc > 0 ? argv[0] : YK_UNDEFINED, ";/?:@&=+$,#");
}
static yk builtin_escape(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_string *in = str(to_string(argc > 0 ? argv[0] : YK_UNDEFINED));
  uint16_t *out = scratch(((size_t)in->len * 6 + 2) * sizeof(uint16_t));
  uint32_t n = 0;
  static const char hex[] = "0123456789ABCDEF";
  for (uint32_t i = 0; i < in->len; i++) {
    uint16_t ch = in->units[i];
    if (in_set(ch, "@*_+-./")) out[n++] = ch;
    else if (ch < 256) {
      out[n++] = '%', out[n++] = (uint16_t)hex[ch >> 4], out[n++] = (uint16_t)hex[ch & 15];
    } else {
      out[n++] = '%', out[n++] = 'u';
      for (int sh = 12; sh >= 0; sh -= 4) out[n++] = (uint16_t)hex[(ch >> sh) & 15];
    }
  }
  yk_string *r = new_string(n);
  memcpy(r->units, out, (size_t)n * 2);
  free(out);
  return string_of(r);
}
static yk builtin_unescape(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_string *in = str(to_string(argc > 0 ? argv[0] : YK_UNDEFINED));
  yk_string *r = new_string(in->len);
  uint32_t n = 0;
  for (uint32_t i = 0; i < in->len; i++) {
    uint16_t ch = in->units[i];
    if (ch == '%' && i + 5 < in->len && in->units[i + 1] == 'u') {
      int h[4], ok = 1;
      for (int j = 0; ok && j < 4; j++) ok = (h[j] = hex_value(in->units[i + 2 + j])) >= 0;
      if (ok) {
        r->units[n++] = (uint16_t)(h[0] << 12 | h[1] << 8 | h[2] << 4 | h[3]);
        i += 5;
        continue;
      }
    }
    if (ch == '%' && i + 2 < in->len && hex_value(in->units[i + 1]) >= 0 && hex_value(in->units[i + 2]) >= 0) {
      r->units[n++] = (uint16_t)(hex_value(in->units[i + 1]) * 16 + hex_value(in->units[i + 2]));
      i += 2;
      continue;
    }
    r->units[n++] = ch;
  }
  r->len = n;
  return string_of(r);
}
/* eval: no code is compiled at run time here. */
static yk builtin_eval(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s, (void)argc, (void)argv;
  type_error("eval compiles code at run time, which the native runtime does not");
  return YK_UNDEFINED;
}
static yk builtin_string(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc > 0 && is_symbol(argv[0])) return symbol_descriptive(argv[0]);
  return argc == 0 ? ascii("") : to_string(argv[0]);
}
/* Symbol([description]): a new symbol (new Symbol throws: it is no constructor). */
static yk builtin_symbol(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return symbol_new(argc > 0 && argv[0] != YK_UNDEFINED ? to_string(argv[0]) : YK_UNDEFINED);
}
/* Symbol.for(key): the registry's symbol for the string, made once; Symbol.keyFor(sym): its key. */
static yk symbol_registry = 0;
static yk symbol_for(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk key = to_string(argc > 0 ? argv[0] : YK_UNDEFINED), known;
  if (symbol_registry == 0) symbol_registry = yk_object_of(0, NULL, NULL);
  if (own_get((yk_object *)PTR(symbol_registry), key, &known)) return known;
  yk sym = symbol_new(key);
  ((yk_symbol *)PTR(sym))->registered = 1;
  own_set((yk_object *)PTR(symbol_registry), key, sym);
  return sym;
}
static yk symbol_key_for(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (!is_symbol(v)) type_error("the value is not a symbol");
  return ((yk_symbol *)PTR(v))->registered ? ((yk_symbol *)PTR(v))->description : YK_UNDEFINED;
}
static yk symbol_to_string_m(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)argc, (void)argv;
  if (!is_symbol(self)) type_error("Symbol.prototype.toString requires that 'this' be a Symbol");
  return symbol_descriptive(self);
}
static yk symbol_value_of_m(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)argc, (void)argv;
  return self;
}
static yk symbol_global(void) {
  static const char *const m[2] = {"for", "keyFor"};
  static const yk_code k[2] = {symbol_for, symbol_key_for};
  yk f = with_methods(builtin_symbol, 2, m, k);
  for (int i = 0; i < N_WELL_KNOWN; i++) yk_set(f, ascii(well_known_names[i]), well_known_symbol(i));
  return f;
}
/* A symbol's members: description, toString, valueOf. */
static int symbol_member(yk sym, yk key, yk *out) {
  static yk fns[2];
  if (key_is(key, "description")) return *out = ((yk_symbol *)PTR(sym))->description, 1;
  if (key_is(key, "toString")) {
    if (fns[0] == 0) fns[0] = yk_closure_new(symbol_to_string_m, 1, 0, NULL);
    return *out = fns[0], 1;
  }
  if (key_is(key, "valueOf")) {
    if (fns[1] == 0) fns[1] = yk_closure_new(symbol_value_of_m, 1, 0, NULL);
    return *out = fns[1], 1;
  }
  return 0;
}
static yk builtin_number(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  if (argc > 0) {
    yk v = to_primitive(argv[0]);
    if (is_bigint(v)) return yk_number(big_to_double_v(v));
  }
  return yk_number(argc == 0 ? 0 : to_number(argv[0]));
}
static yk builtin_boolean(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return yk_bool(argc > 0 && yk_truthy(argv[0]));
}

/* --- promises, async functions and generators (#1295) ---
 *
 * A Promise follows ECMA-262 §27.2: resolving functions with their already-resolved flag, a thenable
 * resolved through a NewPromiseResolveThenableJob, reactions run as jobs in one FIFO queue. An async
 * function and a generator run on a stack of their own (a coroutine): `await` and `yield` suspend it,
 * and a job (for await) or next() (for a generator) resumes it, so the lowering of their bodies is
 * the lowering of any function's. `await v` is PerformPromiseThen(PromiseResolve(v), resume), as the
 * specification has it since ES2019: one job after v settles.
 */

typedef struct reaction {
  int kind;           /* 0 on fulfilment, 1 on rejection */
  yk handler;         /* a function, or 0: the value passes on */
  yk derived;         /* the promise its result settles, or 0 */
  struct coro *resume; /* an await's coroutine, resumed with the value (or with it thrown) */
} reaction;

typedef struct {
  int state; /* 0 pending, 1 fulfilled, 2 rejected */
  yk value;
  reaction **on_fulfil, **on_reject;
  uint32_t n, cap;
} promise_state;

typedef struct coro {
  ucontext_t ctx, back;
  handler *handlers;   /* its own handler chain while it is suspended */
  int state;           /* 0 not started, 1 suspended, 2 running, 3 done */
  int kind;            /* 0 an async function's, 1 a generator's */
  int mode;            /* how it is resumed: 0 with a value, 1 with it thrown, 2 returning it */
  yk transfer;         /* the value it is resumed with, or yields */
  yk_closure *fn;
  yk self;
  uint64_t argc;
  yk *argv;
  yk promise;          /* an async function's result */
  yk result;           /* when done: what it returned, or threw */
  int threw;
  yk returning;        /* a generator's return(v): the v */
  void *stack;
  int awaiting;           /* an async generator's: suspended at an await (a job resumes it) */
  yk_array *requests;     /* an async generator's queue: [mode, value, promise] for each request */
} coro;

#define CORO_STACK (256 * 1024)
static coro *current_coro, *starting_coro;
#if YK_GC
static int gc_in_coroutine(void) { return current_coro != NULL; }
#endif
/* A generator's return() unwinds its body as a throw no catch sees, and finally blocks do. */
static yk generator_return_token;
static int is_generator_return(yk v) { return generator_return_token != 0 && v == generator_return_token; }

static int is_promise(yk v) { return is_object(v) && ((yk_object *)PTR(v))->kind == 4; }
static promise_state *pstate(yk p) { return (promise_state *)((yk_object *)PTR(p))->ext; }

static yk promise_new(void) {
  yk p = yk_object_of(0, NULL, NULL);
  ((yk_object *)PTR(p))->kind = 4;
  ((yk_object *)PTR(p))->ext = alloc(sizeof(promise_state));
  return p;
}

/* The job queue. */
typedef struct {
  int type;     /* 0 a reaction, 1 a thenable to resolve a promise with */
  reaction *r;
  yk argument;
  yk promise, thenable, then;
} job;
static job *jobs;
static size_t jobs_head, jobs_tail, jobs_cap;
static void enqueue(job j) {
  if (jobs_tail == jobs_cap) {
    if (jobs_head > 0) {
      memmove(jobs, jobs + jobs_head, (jobs_tail - jobs_head) * sizeof(job));
      jobs_tail -= jobs_head;
      jobs_head = 0;
    } else {
      size_t old = jobs_cap;
      jobs_cap = jobs_cap == 0 ? 64 : jobs_cap * 2;
      jobs = grow(jobs, old * sizeof(job), jobs_cap * sizeof(job));
    }
  }
  jobs[jobs_tail++] = j;
}

static void settle(yk p, int state, yk value) {
  promise_state *s = pstate(p);
  if (s->state != 0) return;
  s->state = state;
  s->value = value;
  /* TriggerPromiseReactions: each of the settled side, in order, as a job. */
  for (uint32_t i = 0; i < s->n; i++)
    enqueue((job){0, state == 1 ? s->on_fulfil[i] : s->on_reject[i], value, 0, 0, 0});
  s->n = 0;
}
static void reject_promise(yk p, yk reason) { settle(p, 2, reason); }

static yk then_of(yk x, int *threw);
/* The promise's resolve function, without its flag: a thenable is resolved through a job. */
static void resolve_promise(yk p, yk x) {
  if (x == p) {
    reject_promise(p, make_error("TypeError", ascii("Chaining cycle detected for promise #<Promise>")));
    return;
  }
  if (!is_object(x) && !is_closure(x)) {
    settle(p, 1, x);
    return;
  }
  int threw;
  yk then = then_of(x, &threw);
  if (threw) {
    reject_promise(p, then);
    return;
  }
  if (!is_closure(then)) {
    settle(p, 1, x);
    return;
  }
  enqueue((job){1, NULL, 0, p, x, then});
}

/* CreateResolvingFunctions: resolve and reject sharing one already-resolved flag. */
static yk resolving_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  yk_closure *k = (yk_closure *)c;
  yk_array *flag = arr(k->captures[1]);
  if (flag->items[0] == YK_TRUE) return YK_UNDEFINED;
  flag->items[0] = YK_TRUE;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (k->captures[2] == YK_TRUE) reject_promise(k->captures[0], v);
  else resolve_promise(k->captures[0], v);
  return YK_UNDEFINED;
}
static void resolving_functions(yk p, yk *resolve, yk *reject) {
  yk flag = yk_array_of(1, (yk[]){YK_FALSE});
  *resolve = yk_closure_new(resolving_code, 0, 3, (yk[]){p, flag, YK_FALSE});
  *reject = yk_closure_new(resolving_code, 0, 3, (yk[]){p, flag, YK_TRUE});
}

static int protected_call_with(yk f, yk self, uint64_t argc, const yk *argv, yk *result) {
  handler h;
  h.prev = handlers;
  handlers = &h;
  if (setjmp(h.env) == 0) {
    yk r = call_value(f, self, argc, argv);
    handlers = h.prev;
    *result = r;
    return 0;
  }
  handlers = h.prev;
  *result = thrown;
  return 1;
}

/* PerformPromiseThen. */
static void perform_then(yk p, yk on_fulfil, yk on_reject, yk derived, coro *resume) {
  reaction *f = alloc(sizeof(reaction)), *r = alloc(sizeof(reaction));
  *f = (reaction){0, is_closure(on_fulfil) ? on_fulfil : 0, derived, resume};
  *r = (reaction){1, is_closure(on_reject) ? on_reject : 0, derived, resume};
  promise_state *s = pstate(p);
  if (s->state == 0) {
    if (s->n == s->cap) {
      uint32_t old = s->cap;
      s->cap = s->cap == 0 ? 2 : s->cap * 2;
      s->on_fulfil = grow(s->on_fulfil, old * sizeof(reaction *), s->cap * sizeof(reaction *));
      s->on_reject = grow(s->on_reject, old * sizeof(reaction *), s->cap * sizeof(reaction *));
    }
    s->on_fulfil[s->n] = f;
    s->on_reject[s->n++] = r;
  } else
    enqueue((job){0, s->state == 1 ? f : r, s->value, 0, 0, 0});
}

/* PromiseResolve(%Promise%, x): a promise is itself; anything else a promise resolved with it. */
static yk promise_resolve(yk x) {
  if (is_promise(x)) return x;
  yk p = promise_new();
  resolve_promise(p, x);
  return p;
}

static void coro_resume(coro *co, yk value, int mode);
static void async_finish(coro *co);
static void agen_drive(struct coro *co, yk value, int mode);

static void run_job(job j) {
  if (j.type == 1) {
    /* NewPromiseResolveThenableJob: then.call(thenable, resolve, reject). */
    yk resolve, reject, r;
    resolving_functions(j.promise, &resolve, &reject);
    if (protected_call_with(j.then, j.thenable, 2, (yk[]){resolve, reject}, &r))
      call_value(reject, YK_UNDEFINED, 1, &r);
    return;
  }
  reaction *re = j.r;
  if (re->resume != NULL) {
    if (re->resume->kind == 2) {
      agen_drive(re->resume, j.argument, re->kind);
      return;
    }
    coro_resume(re->resume, j.argument, re->kind);
    if (re->resume->state == 3) async_finish(re->resume);
    return;
  }
  if (re->handler == 0) {
    if (re->derived != 0) {
      if (re->kind == 0) resolve_promise(re->derived, j.argument);
      else reject_promise(re->derived, j.argument);
    }
    return;
  }
  yk r;
  int threw = protected_call_with(re->handler, YK_UNDEFINED, 1, &j.argument, &r);
  if (re->derived == 0) return;
  if (threw) reject_promise(re->derived, r);
  else resolve_promise(re->derived, r);
}

/* Runs the jobs until there are none. */
void yk_drain(void) {
  while (jobs_head < jobs_tail) {
    job j = jobs[jobs_head++];
    run_job(j);
  }
  jobs_head = jobs_tail = 0;
}

/* --- coroutines --- */

static void coro_main(void) {
  coro *co = starting_coro;
  handler h;
  h.prev = NULL;
  handlers = &h;
  if (setjmp(h.env) == 0) {
    co->result = co->fn->code(co->fn, co->fn->has_this ? co->self : YK_UNDEFINED, co->argc, co->argv);
    co->threw = 0;
  } else if (is_generator_return(thrown)) {
    co->result = co->returning;
    co->threw = 0;
  } else {
    co->result = thrown;
    co->threw = 1;
  }
  handlers = NULL;
  co->state = 3;
  setcontext(&co->back);
}

static void coro_resume(coro *co, yk value, int mode) {
  coro *prev = current_coro;
  handler *saved = handlers;
  co->transfer = value;
  co->mode = mode;
  /* Its stack is made before it is current: a collection in that alloc is still on the stack it
     was called from, which it scans as that (from gc_main_sp only once the switch is made). */
  if (co->state == 0) co->stack = alloc(CORO_STACK); /* on the heap: a suspended coroutine's frames are scanned */
  current_coro = co;
  if (co->state == 0) {
    getcontext(&co->ctx);
    co->ctx.uc_stack.ss_sp = co->stack;
    co->ctx.uc_stack.ss_size = CORO_STACK;
    co->ctx.uc_link = NULL;
    makecontext(&co->ctx, coro_main, 0);
    starting_coro = co;
  } else
    handlers = co->handlers;
  co->state = 2;
  /* Leaving the main stack: the collector scans it from here up while the coroutine runs. */
  uintptr_t main_sp = gc_main_sp;
  if (prev == NULL) gc_main_sp = (uintptr_t)__builtin_frame_address(0);
  swapcontext(&co->back, &co->ctx);
  gc_main_sp = main_sp;
  current_coro = prev;
  handlers = saved;
  if (co->state == 3) co->stack = NULL; /* the collector takes it */
}

/* Suspends the running coroutine; what it is resumed with, and how (0 next, 1 throw, 2 return). */
static yk coro_suspend_mode(yk out, int *mode) {
  coro *co = current_coro;
  co->transfer = out;
  co->handlers = handlers;
  co->state = 1;
  swapcontext(&co->ctx, &co->back);
  *mode = co->mode;
  return co->transfer;
}

/* The running generator returns `value` through whatever it is in (its finally blocks run). */
static void generator_return_through(yk value) {
  current_coro->returning = value;
  if (generator_return_token == 0) generator_return_token = BOX(T_INTERNAL, alloc(sizeof(int32_t) * 2));
  yk_throw(generator_return_token);
}

/* Suspends the running coroutine; what it is resumed with is returned, thrown, or returned through. */
static yk coro_suspend(yk out) {
  coro *co = current_coro;
  co->transfer = out;
  co->handlers = handlers;
  co->state = 1;
  swapcontext(&co->ctx, &co->back);
  if (co->mode == 1) yk_throw(co->transfer);
  if (co->mode == 2) {
    co->returning = co->transfer;
    if (generator_return_token == 0) generator_return_token = BOX(T_INTERNAL, alloc(sizeof(int32_t) * 2));
    yk_throw(generator_return_token);
  }
  return co->transfer;
}

static coro *coro_new(int kind, yk_closure *c, yk self, uint64_t argc, const yk *argv) {
  coro *co = alloc(sizeof(coro));
  co->kind = kind;
  co->fn = c;
  co->self = self;
  co->argc = argc;
  co->argv = alloc((argc > 0 ? argc : 1) * sizeof(yk));
  memcpy(co->argv, argv, (size_t)argc * sizeof(yk));
  return co;
}

/* --- async functions --- */

static void async_finish(coro *co) {
  if (co->threw) reject_promise(co->promise, co->result);
  else resolve_promise(co->promise, co->result);
}

static yk async_call(void *c, yk self, uint64_t argc, const yk *argv) {
  coro *co = coro_new(0, (yk_closure *)c, self, argc, argv);
  co->promise = promise_new();
  coro_resume(co, YK_UNDEFINED, 0);
  if (co->state == 3) async_finish(co);
  return co->promise;
}

/* await v. */
yk yk_await(yk v) {
  coro *co = current_coro;
  if (co == NULL || co->kind == 1) type_error("await is only valid in async functions here");
  perform_then(promise_resolve(v), 0, 0, 0, co);
  co->awaiting = 1;
  return coro_suspend(YK_UNDEFINED);
}

/* --- async generators (ECMA-262 27.6) ---
 *
 * An object (kind 9) over a coroutine and a queue of requests: next, throw and return each queue one
 * with a new promise, and the body runs while there are requests. It runs until it awaits (a job
 * resumes it), yields (the front request is fulfilled with { value, done: false }, and the next
 * request, if any, resumes it), or completes (each request left is settled as done).
 */
static yk iter_result(yk value, int done);
static void agen_settle(coro *co, int rejected, yk value, int done) {
  yk_array *q = co->requests;
  yk p = q->items[2];
  memmove(q->items, q->items + 3, (size_t)(q->len - 3) * sizeof(yk));
  q->len -= 3;
  if (rejected) reject_promise(p, value);
  else resolve_promise(p, iter_result(value, done));
}
static void agen_drive(coro *co, yk value, int mode) {
  for (;;) {
    if (co->requests->len == 0 && co->state != 2) return;
    if (co->state == 3 || (co->state == 0 && mode != 0)) {
      /* Done, or asked to throw or return before it started: each request is settled as done. */
      co->state = 3;
      while (co->requests->len > 0) {
        int m = (int)to_number(co->requests->items[0]);
        yk v = co->requests->items[1];
        if (m == 1) agen_settle(co, 1, v, 1);
        else agen_settle(co, 0, m == 2 ? v : YK_UNDEFINED, 1);
      }
      return;
    }
    co->awaiting = 0;
    coro_resume(co, value, mode);
    if (co->state == 3) {
      if (co->requests->len > 0) agen_settle(co, co->threw, co->result, 1);
      value = YK_UNDEFINED;
      mode = 0;
      continue;
    }
    if (co->awaiting) return;
    /* It yielded: the front request has its value; the next one, if any, resumes it. */
    if (co->requests->len > 0) agen_settle(co, 0, co->transfer, 0);
    if (co->requests->len == 0) return;
    mode = (int)to_number(co->requests->items[0]);
    value = co->requests->items[1];
  }
}
static yk agen_request(yk self, int mode, yk value) {
  yk p = promise_new();
  if (!is_object(self) || ((yk_object *)PTR(self))->kind != 9) {
    reject_promise(p, make_error("TypeError", ascii("not an async generator")));
    return p;
  }
  coro *co = (coro *)((yk_object *)PTR(self))->ext;
  push(co->requests, yk_number(mode));
  push(co->requests, value);
  push(co->requests, p);
  /* Idle (not started, at a yield, or done) with this the only request: it runs now. */
  if (co->requests->len == 3 && co->state != 2 && !co->awaiting) agen_drive(co, value, mode);
  return p;
}
static yk agen_next(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  return agen_request(self, 0, argc > 0 ? argv[0] : YK_UNDEFINED);
}
static yk agen_throw(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  return agen_request(self, 1, argc > 0 ? argv[0] : YK_UNDEFINED);
}
static yk agen_return(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  return agen_request(self, 2, argc > 0 ? argv[0] : YK_UNDEFINED);
}
static yk agen_new(void *c, yk self, uint64_t argc, const yk *argv);

/* --- generators --- */

static yk agen_new(void *c, yk self, uint64_t argc, const yk *argv) {
  yk g = yk_object_of(0, NULL, NULL);
  ((yk_object *)PTR(g))->kind = 9;
  ((yk_object *)PTR(g))->proto = ensure_prototype(BOX(T_CLOSURE, c));
  coro *co = coro_new(2, (yk_closure *)c, self, argc, argv);
  co->requests = new_array(6);
  ((yk_object *)PTR(g))->ext = co;
  return g;
}
static yk generator_new(void *c, yk self, uint64_t argc, const yk *argv) {
  yk g = yk_object_of(0, NULL, NULL);
  ((yk_object *)PTR(g))->kind = 5;
  ((yk_object *)PTR(g))->proto = ensure_prototype(BOX(T_CLOSURE, c));
  ((yk_object *)PTR(g))->ext = coro_new(1, (yk_closure *)c, self, argc, argv);
  return g;
}

static yk iter_result(yk value, int done) {
  yk keys[2] = {ascii("value"), ascii("done")};
  yk values[2] = {value, yk_bool(done)};
  return yk_object_of(2, keys, values);
}

/* Resumes a generator; 1 with what it yielded, 0 with what it returned; a throw propagates. */
static int generator_resume(yk g, yk value, int mode, yk *out) {
  coro *co = (coro *)((yk_object *)PTR(g))->ext;
  if (co->state == 2) type_error("Generator is already running");
  if (co->state == 3 || (co->state == 0 && mode != 0)) {
    co->state = 3;
    if (mode == 1) yk_throw(value);
    *out = mode == 2 ? value : YK_UNDEFINED;
    return 0;
  }
  coro_resume(co, value, mode);
  if (co->state == 3) {
    if (co->threw) yk_throw(co->result);
    *out = co->result;
    return 0;
  }
  *out = co->transfer;
  return 1;
}
static int generator_step(yk g, yk *out) { return generator_resume(g, YK_UNDEFINED, 0, out); }

/* yield v. */
yk yk_yield(yk v) {
  coro *co = current_coro;
  if (co == NULL || co->kind == 0) type_error("yield is only valid in generators here");
  if (co->kind == 2) {
    /* An async generator awaits what it yields; what it is resumed with, it takes as a generator. */
    v = yk_await(v);
    co->awaiting = 0;
  }
  return coro_suspend(v);
}

/* yield* v: each value v's iteration gives, yielded in turn; its return value is the result. What
   the consumer sends, throws or returns is passed on to a generator delegated to, so its catch and
   finally blocks see it, as ECMAScript's yield* does (#1330). */
yk yk_yield_star(yk v) {
  if (current_coro != NULL && current_coro->kind == 2 && is_object(v) && ((yk_object *)PTR(v))->kind == 9) {
    /* yield* in an async generator, to another: each request passed on and its result awaited; its
       values yielded as they are. */
    coro *co = current_coro;
    yk sent = YK_UNDEFINED;
    int mode = 0;
    for (;;) {
      yk r = yk_await(agen_request(v, mode, sent));
      yk value = yk_get(r, ascii("value"));
      if (yk_truthy(yk_get(r, ascii("done")))) {
        if (mode == 2) generator_return_through(value);
        return value;
      }
      co->awaiting = 0;
      sent = coro_suspend_mode(value, &mode);
    }
  }
  if (is_object(v) && ((yk_object *)PTR(v))->kind == 5) {
    coro *co = current_coro;
    if (co == NULL || co->kind != 1) type_error("yield is only valid in generators here");
    yk sent = YK_UNDEFINED, out;
    int mode = 0;
    for (;;) {
      if (!generator_resume(v, sent, mode, &out)) {
        /* Done: by return(), this generator returns too, with what the delegate returned. */
        if (mode == 2) generator_return_through(out);
        return out;
      }
      sent = coro_suspend_mode(out, &mode);
    }
  }
  yk it = yk_iter_new(v, 0), e;
  while (yk_iter_next(it, &e)) yk_yield(e);
  return YK_UNDEFINED;
}

/* __yakccTryGen(body, handler, finalizer): a try statement in a generator whose blocks yield, its
   blocks generator functions delegated to in turn (#1330). As __yakccTry, but each block is run as
   yield* block(): what the consumer sends, throws or returns reaches it. */
static yk star_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  return yk_yield_star(call_value(((yk_closure *)c)->captures[0], YK_UNDEFINED, argc, argv));
}
static yk try_gen_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk body = argv[0], handler_fn = argc > 1 ? argv[1] : YK_UNDEFINED, fin = argc > 2 ? argv[2] : YK_UNDEFINED;
  yk r;
  int threw = protected_call(yk_closure_new(star_code, 0, 1, &body), 0, NULL, &r);
  if (threw && is_closure(handler_fn) && !is_generator_return(r)) {
    yk exc = r;
    threw = protected_call(yk_closure_new(star_code, 0, 1, &handler_fn), 1, &exc, &r);
  }
  if (is_closure(fin)) {
    yk done = call_value(yk_closure_new(star_code, 0, 1, &fin), YK_UNDEFINED, 0, NULL);
    if (is_array(done) && arr(done)->len > 0 && strict_equal(arr(done)->items[0], yk_number(1))) return done;
  }
  if (threw) yk_throw(r);
  return r;
}

/* __yakccTryAsyncGen: __yakccTryGen in an async generator; its blocks are async generators. */
static yk try_async_gen_code(void *c, yk self, uint64_t argc, const yk *argv) {
  return try_gen_code(c, self, argc, argv);
}

/* Leaving a for…of early (a break, or a return from the loop's function) closes its iterator: a
   generator's return() runs, so its finally blocks do (IteratorClose). Done iterators are left. */
void yk_iter_close(yk itv) {
  yk_iter *it = (yk_iter *)PTR(itv);
  if (it->proto != 0) {
    /* IteratorClose: its return(), if it has one. */
    if (it->finished) return;
    it->finished = 1;
    yk ret = yk_get(it->proto, ascii("return"));
    if (is_closure(ret)) {
      yk r = call_value(ret, it->proto, 0, NULL);
      if (it->proto_async) yk_await(r);
    }
    return;
  }
  if (it->agen != 0) {
    coro *ac = (coro *)((yk_object *)PTR(it->agen))->ext;
    if (ac->state != 3) yk_await(agen_request(it->agen, 2, YK_UNDEFINED));
    return;
  }
  if (it->gen == 0) return;
  coro *co = (coro *)((yk_object *)PTR(it->gen))->ext;
  if (co->state == 3) return;
  yk out;
  generator_resume(it->gen, YK_UNDEFINED, 2, &out);
}

/* --- the methods of promises and generators --- */

static yk promise_then(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  if (!is_promise(self)) type_error("Method Promise.prototype.then called on incompatible receiver");
  yk derived = promise_new();
  perform_then(self, argc > 0 ? argv[0] : 0, argc > 1 ? argv[1] : 0, derived, NULL);
  return derived;
}
static yk promise_catch(void *c, yk self, uint64_t argc, const yk *argv) {
  yk args[2] = {YK_UNDEFINED, argc > 0 ? argv[0] : YK_UNDEFINED};
  return promise_then(c, self, 2, args);
}
/* finally(f): thenFinally / catchFinally, each running f, then passing the value (or reason) on
   after the promise f's result resolves to. */
static yk value_thunk(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self, (void)argc, (void)argv;
  return ((yk_closure *)c)->captures[0];
}
static yk thrower(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self, (void)argc, (void)argv;
  yk_throw(((yk_closure *)c)->captures[0]);
  return YK_UNDEFINED;
}
static yk finally_step(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  yk_closure *k = (yk_closure *)c;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  yk result = call_value(k->captures[0], YK_UNDEFINED, 0, NULL);
  yk p = promise_resolve(result);
  yk next = yk_closure_new(k->captures[1] == YK_TRUE ? thrower : value_thunk, 0, 1, &v);
  return promise_then(NULL, p, 1, &next);
}
static yk promise_finally(void *c, yk self, uint64_t argc, const yk *argv) {
  yk f = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (!is_closure(f)) return promise_then(c, self, 2, (yk[]){f, f});
  yk on_fulfil = yk_closure_new(finally_step, 0, 2, (yk[]){f, YK_FALSE});
  yk on_reject = yk_closure_new(finally_step, 0, 2, (yk[]){f, YK_TRUE});
  return promise_then(c, self, 2, (yk[]){on_fulfil, on_reject});
}
static yk generator_next(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  yk out;
  int more = generator_resume(self, argc > 0 ? argv[0] : YK_UNDEFINED, 0, &out);
  return iter_result(out, !more);
}
static yk generator_throw(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  yk out;
  int more = generator_resume(self, argc > 0 ? argv[0] : YK_UNDEFINED, 1, &out);
  return iter_result(out, !more);
}
static yk generator_return(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c;
  yk out;
  int more = generator_resume(self, argc > 0 ? argv[0] : YK_UNDEFINED, 2, &out);
  return iter_result(out, !more);
}

/* A promise's or a generator's method by name, or 0. */
static yk async_member(void *obj, yk key) {
  yk_object *o = (yk_object *)obj;
  static yk fns[9];
  static const char *const names[9] = {"then", "catch", "finally", "next", "throw", "return", "next", "throw", "return"};
  static const yk_code codes[9] = {promise_then,   promise_catch, promise_finally,
                                   generator_next, generator_throw, generator_return,
                                   agen_next,      agen_throw,      agen_return};
  int from = o->kind == 4 ? 0 : o->kind == 5 ? 3 : 6;
  for (int i = from; i < from + 3; i++)
    if (key_is(key, names[i])) {
      if (fns[i] == 0) fns[i] = yk_closure_new(codes[i], 1, 0, NULL);
      return fns[i];
    }
  return 0;
}

/* Get(x, "then"), as resolving a promise with x does: a getter may throw. */
static yk then_of(yk x, int *threw) {
  *threw = 0;
  if (is_promise(x)) return async_member(PTR(x), ascii("then"));
  if (is_object(x) && ((yk_object *)PTR(x))->kind != 0) return YK_UNDEFINED;
  handler h;
  h.prev = handlers;
  handlers = &h;
  if (setjmp(h.env) == 0) {
    yk slot, r = chain_get(x, ascii("then"), &slot) ? resolve_slot(slot, x) : YK_UNDEFINED;
    handlers = h.prev;
    return r;
  }
  handlers = h.prev;
  *threw = 1;
  return thrown;
}

/* --- the Promise constructor and its statics --- */

static yk builtin_promise(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self, (void)argc, (void)argv;
  type_error("Promise constructor cannot be invoked without 'new'");
  return YK_UNDEFINED;
}
/* new Promise(executor). */
static yk promise_construct(uint64_t argc, const yk *argv) {
  yk executor = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (!is_closure(executor)) type_error("Promise resolver is not a function");
  yk p = promise_new(), resolve, reject, r;
  resolving_functions(p, &resolve, &reject);
  if (protected_call_with(executor, YK_UNDEFINED, 2, (yk[]){resolve, reject}, &r))
    call_value(reject, YK_UNDEFINED, 1, &r);
  return p;
}
static yk promise_static_resolve(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return promise_resolve(argc > 0 ? argv[0] : YK_UNDEFINED);
}

/* import(spec) (#1370): a promise of the module's namespace (an ECMAScript module's) or exports (a
   CommonJS module's), the module loaded by its require in a job (a throw rejects the promise). */
static yk import_job(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self, (void)argc, (void)argv;
  yk_closure *k = (yk_closure *)c;
  return call_value(k->captures[0], YK_UNDEFINED, 1, &k->captures[1]);
}
yk yk_import(yk require, yk spec) {
  yk done = promise_static_resolve(NULL, YK_UNDEFINED, 0, NULL);
  yk load = yk_closure_new(import_job, 0, 2, (yk[]){require, to_string(spec)});
  return call_method_key(done, ascii("then"), 1, &load);
}
static yk promise_static_reject(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk p = promise_new();
  reject_promise(p, argc > 0 ? argv[0] : YK_UNDEFINED);
  return p;
}
/* Promise.all / allSettled: each element's settling recorded at its index, once. */
static yk combinator_element(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  /* captures: the result promise, the values, the index, the remaining count, the called flag,
     the shape (0 all, 1 allSettled fulfilled, 2 allSettled rejected) */
  yk_closure *k = (yk_closure *)c;
  yk_array *called = arr(k->captures[4]);
  if (called->items[0] == YK_TRUE) return YK_UNDEFINED;
  called->items[0] = YK_TRUE;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  int shape = (int)num(k->captures[5]);
  if (shape != 0) {
    yk keys[2] = {ascii("status"), ascii(shape == 1 ? "value" : "reason")};
    yk values[2] = {ascii(shape == 1 ? "fulfilled" : "rejected"), v};
    v = yk_object_of(2, keys, values);
  }
  arr(k->captures[1])->items[(uint32_t)num(k->captures[2])] = v;
  yk_array *remaining = arr(k->captures[3]);
  remaining->items[0] = yk_number(num(remaining->items[0]) - 1);
  if (num(remaining->items[0]) == 0) resolve_promise(k->captures[0], k->captures[1]);
  return YK_UNDEFINED;
}
static yk promise_combine(uint64_t argc, const yk *argv, int settled) {
  yk result = promise_new(), resolve, reject;
  resolving_functions(result, &resolve, &reject);
  yk_array *items = iterable_items(argc > 0 ? argv[0] : YK_UNDEFINED);
  yk values = BOX(T_ARRAY, new_array(items->len > 0 ? items->len : 1));
  arr(values)->len = items->len;
  for (uint32_t i = 0; i < items->len; i++) arr(values)->items[i] = YK_UNDEFINED;
  yk remaining = yk_array_of(1, (yk[]){yk_number(1)});
  for (uint32_t i = 0; i < items->len; i++) {
    yk next = promise_resolve(items->items[i]);
    yk called = yk_array_of(1, (yk[]){YK_FALSE});
    yk caps[6] = {result, values, yk_number(i), remaining, called, yk_number(settled ? 1 : 0)};
    yk on_fulfil = yk_closure_new(combinator_element, 0, 6, caps);
    yk on_reject = reject;
    if (settled) {
      caps[5] = yk_number(2);
      on_reject = yk_closure_new(combinator_element, 0, 6, caps);
    }
    arr(remaining)->items[0] = yk_number(num(arr(remaining)->items[0]) + 1);
    promise_then(NULL, next, 2, (yk[]){on_fulfil, on_reject});
  }
  arr(remaining)->items[0] = yk_number(num(arr(remaining)->items[0]) - 1);
  if (num(arr(remaining)->items[0]) == 0) resolve_promise(result, values);
  return result;
}
static yk promise_static_all(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return promise_combine(argc, argv, 0);
}
static yk promise_static_all_settled(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  return promise_combine(argc, argv, 1);
}
static yk promise_static_race(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk result = promise_new(), resolve, reject;
  resolving_functions(result, &resolve, &reject);
  yk_array *items = iterable_items(argc > 0 ? argv[0] : YK_UNDEFINED);
  for (uint32_t i = 0; i < items->len; i++)
    promise_then(NULL, promise_resolve(items->items[i]), 2, (yk[]){resolve, reject});
  return result;
}

/* __yakccTryAsync(body, handler, finalizer): the async try primitive, as the TypeScript lowering's
   runtime defines it: try { try { return await body() } catch (t) { …; return await handler(t) } }
   finally { const done = await finalizer(); if (done is [1, …]) return done }. */
static yk try_async_body(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk body = argv[0], handler_fn = argc > 1 ? argv[1] : YK_UNDEFINED, fin = argc > 2 ? argv[2] : YK_UNDEFINED;
  yk r;
  int threw;
  {
    handler h;
    h.prev = handlers;
    handlers = &h;
    if (setjmp(h.env) == 0) {
      r = yk_await(call_value(body, YK_UNDEFINED, 0, NULL));
      threw = 0;
    } else {
      r = thrown;
      threw = 1;
    }
    handlers = h.prev;
  }
  if (threw && is_closure(handler_fn) && !is_generator_return(r)) {
    yk exc = r;
    handler h;
    h.prev = handlers;
    handlers = &h;
    if (setjmp(h.env) == 0) {
      r = yk_await(call_value(handler_fn, YK_UNDEFINED, 1, &exc));
      threw = 0;
    } else {
      r = thrown;
      threw = 1;
    }
    handlers = h.prev;
  }
  if (is_closure(fin)) {
    yk done = yk_await(call_value(fin, YK_UNDEFINED, 0, NULL));
    if (is_array(done) && arr(done)->len > 0 && strict_equal(arr(done)->items[0], yk_number(1))) return done;
  }
  if (threw) yk_throw(r);
  return r;
}

static yk builtin_queue_microtask(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk f = argc > 0 ? argv[0] : YK_UNDEFINED;
  if (!is_closure(f)) type_error("The callback must be a function");
  /* A reaction with no derived promise: the job calls f. */
  reaction *r = alloc(sizeof(reaction));
  *r = (reaction){0, f, 0, NULL};
  enqueue((job){0, r, YK_UNDEFINED, 0, 0, 0});
  return YK_UNDEFINED;
}

/* A closure's mode, set where it is made: async (1) or a generator (2). */
yk yk_closure_mode(yk f, int32_t mode) {
  ((yk_closure *)PTR(f))->mode = mode;
  return f;
}

/* After a call: the jobs run; a promise is its value, or ["rejected", String(reason)], or
   ["pending"] if nothing settles it. */
yk yk_settle(yk v) {
  yk_drain();
  if (!is_promise(v)) return v;
  promise_state *s = pstate(v);
  if (s->state == 1) return s->value;
  if (s->state == 2) return yk_array_of(2, (yk[]){ascii("rejected"), to_string(s->value)});
  return yk_array_of(1, (yk[]){ascii("pending")});
}

/*
 * A global the platform gives, by name: a function value, NaN or Infinity, or undefined when the
 * runtime has none (so a `typeof` probe for it sees what a platform without it gives).
 */
/* --- ArrayBuffer, the typed arrays, DataView and TextEncoder (ECMA-262 25.1-25.3, 23.2; WHATWG
 * Encoding) -----------------------------------------------------------------------------------
 *
 * An ArrayBuffer (object kind 6) owns its bytes; a typed array (kind 7) and a DataView (kind 8) are
 * views of one: its buffer, a byte offset and a length (elements, or bytes for a DataView), so views
 * of one buffer see each other's writes. Elements are stored as the platform's bytes; every target
 * is little-endian, and a DataView reads and writes the order it is told. A typed array's element
 * write converts as ECMA-262's does (ToInt8 … ToUint8Clamp, ToBigInt64 …); an index that is not one
 * of its elements reads undefined and writes nothing.
 */

typedef struct {
  uint32_t len;
  uint8_t *data;
} yk_buffer;
typedef struct {
  yk buffer;
  uint32_t offset, length;
  int32_t type;
} yk_view;

/* The lowering reads these fields itself (emit-llvm-boxed.ts's indexRead and lengthRead, as LLVM
   struct types): each struct's fields up to those keep this order and these types. */
struct yk_array_mirror { uint32_t len, cap; yk *items; yk props; uint8_t *holes; };
struct yk_object_mirror { uint32_t len, cap; yk *keys, *values; int32_t error, kind; yk proto; yk *regex; yk_array *entries; void *ext; };
struct yk_view_mirror { yk buffer; uint32_t offset, length; int32_t type; };
struct yk_buffer_mirror { uint32_t len; uint8_t *data; };
_Static_assert(offsetof(yk_array, len) == offsetof(struct yk_array_mirror, len) &&
                   offsetof(yk_array, items) == offsetof(struct yk_array_mirror, items) &&
                   offsetof(yk_array, holes) == offsetof(struct yk_array_mirror, holes),
               "yk_array's layout is the lowering's");
_Static_assert(offsetof(yk_object, kind) == offsetof(struct yk_object_mirror, kind) &&
                   offsetof(yk_object, ext) == offsetof(struct yk_object_mirror, ext),
               "yk_object's layout is the lowering's");
_Static_assert(offsetof(yk_view, buffer) == offsetof(struct yk_view_mirror, buffer) &&
                   offsetof(yk_view, offset) == offsetof(struct yk_view_mirror, offset) &&
                   offsetof(yk_view, length) == offsetof(struct yk_view_mirror, length) &&
                   offsetof(yk_view, type) == offsetof(struct yk_view_mirror, type),
               "yk_view's layout is the lowering's");
_Static_assert(offsetof(yk_buffer, data) == offsetof(struct yk_buffer_mirror, data),
               "yk_buffer's layout is the lowering's");
_Static_assert(offsetof(yk_string, len) == 0 && offsetof(yk_string, units) == 4,
               "a string's length, then its units");

enum { TA_I8, TA_U8, TA_U8C, TA_I16, TA_U16, TA_I32, TA_U32, TA_F32, TA_F64, TA_BI64, TA_BU64, TA_COUNT };
static const char *const ta_names[TA_COUNT] = {"Int8Array",   "Uint8Array",    "Uint8ClampedArray",
                                               "Int16Array",  "Uint16Array",   "Int32Array",
                                               "Uint32Array", "Float32Array",  "Float64Array",
                                               "BigInt64Array", "BigUint64Array"};
static const uint32_t ta_size[TA_COUNT] = {1, 1, 1, 2, 2, 4, 4, 4, 8, 8, 8};
#define K_BUFFER 6
#define K_TYPED 7
_Static_assert(K_TYPED == 7 && TA_U32 == 6 && TA_U8 == 1, "the kinds and element types the lowering reads");
#define K_DATAVIEW 8

static yk_object *object_of_kind(yk v, int32_t kind) {
  if (!is_object(v)) return NULL;
  yk_object *o = (yk_object *)PTR(v);
  return o->kind == kind ? o : NULL;
}
static yk_buffer *buffer_of(yk v) {
  yk_object *o = object_of_kind(v, K_BUFFER);
  return o == NULL ? NULL : (yk_buffer *)o->ext;
}
static yk_view *typed_of(yk v) {
  yk_object *o = object_of_kind(v, K_TYPED);
  return o == NULL ? NULL : (yk_view *)o->ext;
}
static yk_view *dataview_of(yk v) {
  yk_object *o = object_of_kind(v, K_DATAVIEW);
  return o == NULL ? NULL : (yk_view *)o->ext;
}
static yk new_kind(int32_t kind, void *ext) {
  yk v = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(v);
  o->kind = kind;
  o->ext = ext;
  return v;
}
static yk new_buffer(uint32_t len) {
  yk_buffer *b = alloc(sizeof(yk_buffer));
  b->len = len;
  b->data = alloc(len + 1);
  memset(b->data, 0, len + 1);
  return new_kind(K_BUFFER, b);
}
static yk new_typed(int32_t type, yk buffer, uint32_t offset, uint32_t length) {
  yk_view *t = alloc(sizeof(yk_view));
  *t = (yk_view){buffer, offset, length, type};
  return new_kind(K_TYPED, t);
}
static uint8_t *view_bytes(yk_view *t) { return buffer_of(t->buffer)->data + t->offset; }
static int is_bigint_type(int32_t type) { return type == TA_BI64 || type == TA_BU64; }

/* ToIndex: a RangeError for a negative or too large value. */
static uint32_t to_index(yk v, const char *what) {
  if (v == YK_UNDEFINED) return 0;
  double d = to_number(v);
  if (d != d) d = 0;
  d = trunc(d);
  if (d < 0 || d > 4294967295.0) range_error(what);
  return (uint32_t)d;
}

/* The bits of ToUint32 of a double (modulo 2^32). */
static uint32_t double_to_u32(double d) {
  /* Below 2^63 in magnitude: its int64's low 32 bits (ToUint32's modulo), with no fmod. */
  if (fabs(d) < 9.2e18) return (uint32_t)(int64_t)d;
  if (d != d || isinf(d)) return 0;
  d = fmod(trunc(d), 4294967296.0);
  if (d < 0) d += 4294967296.0;
  return (uint32_t)d;
}
static yk_bigint *want_bigint(yk v) {
  v = to_primitive(v);
  if (v == YK_TRUE) return big(big_from_u64(1, 0));
  if (v == YK_FALSE) return big(big_from_u64(0, 0));
  if (is_string(v)) {
    yk b = big_from_string_v(v);
    if (b == 0) yk_throw(make_error("SyntaxError", ascii("Cannot convert the string to a BigInt")));
    return big(b);
  }
  if (!is_bigint(v)) type_error("Cannot convert the value to a BigInt");
  return big(v);
}

static yk ta_get(yk_view *t, uint32_t i) {
  uint8_t *p = view_bytes(t) + (size_t)i * ta_size[t->type];
  switch (t->type) {
  case TA_I8: return yk_number(*(int8_t *)p);
  case TA_U8:
  case TA_U8C: return yk_number(*p);
  case TA_I16: { int16_t x; memcpy(&x, p, 2); return yk_number(x); }
  case TA_U16: { uint16_t x; memcpy(&x, p, 2); return yk_number(x); }
  case TA_I32: { int32_t x; memcpy(&x, p, 4); return yk_number(x); }
  case TA_U32: { uint32_t x; memcpy(&x, p, 4); return yk_number(x); }
  case TA_F32: { float x; memcpy(&x, p, 4); return yk_number(x); }
  case TA_F64: { double x; memcpy(&x, p, 8); return yk_number(x); }
  case TA_BI64: { int64_t x; memcpy(&x, p, 8); return big_from_i64(x); }
  default: { uint64_t x; memcpy(&x, p, 8); return big_from_u64(x, 0); }
  }
}
/* A value converted as an element of the type: its bytes. */
static void ta_encode(int32_t type, yk value, uint8_t *p) {
  if (is_bigint_type(type)) {
    uint64_t x = big_low64(want_bigint(value));
    memcpy(p, &x, 8);
    return;
  }
  double d = to_number(value);
  switch (type) {
  case TA_I8:
  case TA_U8: *p = (uint8_t)double_to_u32(d); return;
  case TA_U8C: {
    /* ToUint8Clamp: NaN 0; clamped to [0, 255]; rounded half to even. */
    uint8_t c;
    if (d != d || d <= 0) c = 0;
    else if (d >= 255) c = 255;
    else {
      double f = floor(d);
      c = (uint8_t)(f + 0.5 < d ? f + 1 : d < f + 0.5 ? f : ((uint32_t)f % 2 == 0 ? f : f + 1));
    }
    *p = c;
    return;
  }
  case TA_I16:
  case TA_U16: { uint16_t x = (uint16_t)double_to_u32(d); memcpy(p, &x, 2); return; }
  case TA_I32:
  case TA_U32: { uint32_t x = double_to_u32(d); memcpy(p, &x, 4); return; }
  case TA_F32: { float x = (float)d; memcpy(p, &x, 4); return; }
  default: memcpy(p, &d, 8); return;
  }
}
static void ta_set(yk_view *t, uint32_t i, yk value) {
  uint8_t tmp[8];
  /* The value converts first (which may throw), then is stored. */
  ta_encode(t->type, value, tmp);
  memcpy(view_bytes(t) + (size_t)i * ta_size[t->type], tmp, ta_size[t->type]);
}

/* A key of an integer-indexed object: 1 and its index if it is a CanonicalNumericIndexString (or
   a number) that names an element; -1 if it is numeric but names none; 0 if it is not numeric. */
static int typed_index(yk key, uint32_t length, uint32_t *out) {
  double d;
  if (is_number(key)) d = num(key);
  else if (is_string(key)) {
    yk_string *s = str(key);
    if (s->len == 2 && s->units[0] == '-' && s->units[1] == '0') return -1;
    d = string_to_number(s);
    if (!string_equal(str(number_to_string(d)), s)) return 0;
  } else
    return 0;
  if (d != d || d != trunc(d) || d < 0 || (d == 0 && 1 / d < 0) || d >= length) return -1;
  *out = (uint32_t)d;
  return 1;
}

/* A typed array made from a source: its elements, each converted. */
static yk typed_from_items(int32_t type, yk_array *items) {
  yk buf = new_buffer(items->len * ta_size[type]);
  yk v = new_typed(type, buf, 0, items->len);
  yk_view *t = typed_of(v);
  for (uint32_t i = 0; i < items->len; i++) ta_set(t, i, items->items[i]);
  return v;
}
static yk_array *typed_items(yk_view *t) {
  yk_array *a = new_array(t->length);
  for (uint32_t i = 0; i < t->length; i++) push(a, ta_get(t, i));
  return a;
}

/* new T(), new T(length), new T(typedArray | arrayLike | iterable), new T(buffer, offset, length). */
static yk typed_construct(int32_t type, uint64_t argc, const yk *argv) {
  yk a0 = argc > 0 ? argv[0] : YK_UNDEFINED;
  uint32_t size = ta_size[type];
  yk_buffer *b = buffer_of(a0);
  if (b != NULL) {
    uint32_t offset = to_index(argc > 1 ? argv[1] : YK_UNDEFINED, "Start offset is out of bounds");
    if (offset % size != 0) range_error("start offset of the typed array should be a multiple of its element size");
    uint32_t length;
    if (argc > 2 && argv[2] != YK_UNDEFINED) {
      length = to_index(argv[2], "Invalid typed array length");
      if ((uint64_t)offset + (uint64_t)length * size > b->len) range_error("Invalid typed array length");
    } else {
      if (b->len % size != 0) range_error("byte length of the typed array should be a multiple of its element size");
      if (offset > b->len) range_error("Start offset is outside the bounds of the buffer");
      length = (b->len - offset) / size;
    }
    return new_typed(type, a0, offset, length);
  }
  yk_view *src = typed_of(a0);
  if (src != NULL) {
    if (is_bigint_type(type) != is_bigint_type(src->type)) type_error("Content types of the typed arrays differ");
    return typed_from_items(type, typed_items(src));
  }
  if (is_reference(a0)) return typed_from_items(type, iterable_items(a0));
  uint32_t n = to_index(a0, "Invalid typed array length");
  return new_typed(type, new_buffer(n * size), 0, n);
}

static int32_t type_of_code(yk_code code);

/* T.from(source, mapFn) and T.of(...items). */
static yk typed_from(int32_t type, uint64_t argc, const yk *argv) {
  yk_array *items = iterable_items(argc > 0 ? argv[0] : YK_UNDEFINED);
  if (argc > 1 && argv[1] != YK_UNDEFINED) {
    if (!is_closure(argv[1])) type_error("the map function is not a function");
    yk_array *mapped = new_array(items->len);
    for (uint32_t i = 0; i < items->len; i++) {
      yk args[2] = {items->items[i], yk_number(i)};
      push(mapped, call_value(argv[1], argc > 2 ? argv[2] : YK_UNDEFINED, 2, args));
    }
    items = mapped;
  }
  return typed_from_items(type, items);
}
static yk typed_of_items(int32_t type, uint64_t argc, const yk *argv) {
  yk_array *items = new_array((uint32_t)argc);
  for (uint64_t i = 0; i < argc; i++) push(items, argv[i]);
  return typed_from_items(type, items);
}

#define TYPED_BUILTINS(k)                                                                       \
  static yk builtin_ta_##k(void *c, yk s, uint64_t argc, const yk *argv) {                       \
    (void)c, (void)s;                                                                            \
    return typed_construct(k, argc, argv);                                                       \
  }                                                                                              \
  static yk builtin_ta_from_##k(void *c, yk s, uint64_t argc, const yk *argv) {                  \
    (void)c, (void)s;                                                                            \
    return typed_from(k, argc, argv);                                                            \
  }                                                                                              \
  static yk builtin_ta_of_##k(void *c, yk s, uint64_t argc, const yk *argv) {                    \
    (void)c, (void)s;                                                                            \
    return typed_of_items(k, argc, argv);                                                        \
  }
TYPED_BUILTINS(0)
TYPED_BUILTINS(1)
TYPED_BUILTINS(2)
TYPED_BUILTINS(3)
TYPED_BUILTINS(4)
TYPED_BUILTINS(5)
TYPED_BUILTINS(6)
TYPED_BUILTINS(7)
TYPED_BUILTINS(8)
TYPED_BUILTINS(9)
TYPED_BUILTINS(10)
static const yk_code ta_codes[TA_COUNT] = {builtin_ta_0, builtin_ta_1, builtin_ta_2, builtin_ta_3,
                                           builtin_ta_4, builtin_ta_5, builtin_ta_6, builtin_ta_7,
                                           builtin_ta_8, builtin_ta_9, builtin_ta_10};
static const yk_code ta_from_codes[TA_COUNT] = {
    builtin_ta_from_0, builtin_ta_from_1, builtin_ta_from_2, builtin_ta_from_3,
    builtin_ta_from_4, builtin_ta_from_5, builtin_ta_from_6, builtin_ta_from_7,
    builtin_ta_from_8, builtin_ta_from_9, builtin_ta_from_10};
static const yk_code ta_of_codes[TA_COUNT] = {builtin_ta_of_0, builtin_ta_of_1, builtin_ta_of_2,
                                              builtin_ta_of_3, builtin_ta_of_4, builtin_ta_of_5,
                                              builtin_ta_of_6, builtin_ta_of_7, builtin_ta_of_8,
                                              builtin_ta_of_9, builtin_ta_of_10};
static int view_type(yk v) { return typed_of(v)->type; }
static uint32_t ta_bytes(int type) { return ta_size[type]; }
static const char *ta_name(int type) { return ta_names[type]; }
static int32_t type_of_code(yk_code code) {
  for (int32_t k = 0; k < TA_COUNT; k++)
    if (ta_codes[k] == code) return k;
  return -1;
}

static yk builtin_array_buffer(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return new_buffer(to_index(argc > 0 ? argv[0] : YK_UNDEFINED, "Array buffer allocation failed"));
}
static yk builtin_array_buffer_is_view(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  return yk_bool(typed_of(v) != NULL || dataview_of(v) != NULL);
}
static yk builtin_data_view(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_buffer *b = buffer_of(argc > 0 ? argv[0] : YK_UNDEFINED);
  if (b == NULL) type_error("First argument to DataView constructor must be an ArrayBuffer");
  uint32_t offset = to_index(argc > 1 ? argv[1] : YK_UNDEFINED, "Start offset is outside the bounds of the buffer");
  if (offset > b->len) range_error("Start offset is outside the bounds of the buffer");
  uint32_t length = b->len - offset;
  if (argc > 2 && argv[2] != YK_UNDEFINED) {
    length = to_index(argv[2], "Invalid DataView length");
    if ((uint64_t)offset + length > b->len) range_error("Invalid DataView length");
  }
  yk_view *v = alloc(sizeof(yk_view));
  *v = (yk_view){argv[0], offset, length, 0};
  return new_kind(K_DATAVIEW, v);
}

/* UTF-8 of a string's units: a lone surrogate is U+FFFD. */
static yk utf8_bytes(yk_string *s) {
  uint8_t *out = alloc((size_t)s->len * 3 + 1);
  uint32_t n = 0;
  for (uint32_t i = 0; i < s->len; i++) {
    uint32_t c = s->units[i];
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s->len && s->units[i + 1] >= 0xDC00 && s->units[i + 1] <= 0xDFFF) {
      c = 0x10000 + ((c - 0xD800) << 10) + (s->units[i + 1] - 0xDC00);
      i++;
    } else if (c >= 0xD800 && c <= 0xDFFF)
      c = 0xFFFD;
    if (c < 0x80) out[n++] = (uint8_t)c;
    else if (c < 0x800) {
      out[n++] = (uint8_t)(0xC0 | (c >> 6));
      out[n++] = (uint8_t)(0x80 | (c & 63));
    } else if (c < 0x10000) {
      out[n++] = (uint8_t)(0xE0 | (c >> 12));
      out[n++] = (uint8_t)(0x80 | ((c >> 6) & 63));
      out[n++] = (uint8_t)(0x80 | (c & 63));
    } else {
      out[n++] = (uint8_t)(0xF0 | (c >> 18));
      out[n++] = (uint8_t)(0x80 | ((c >> 12) & 63));
      out[n++] = (uint8_t)(0x80 | ((c >> 6) & 63));
      out[n++] = (uint8_t)(0x80 | (c & 63));
    }
  }
  yk buf = new_buffer(n);
  memcpy(buffer_of(buf)->data, out, n);
  return new_typed(TA_U8, buf, 0, n);
}
static yk text_encoder_encode(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  return utf8_bytes(str(v == YK_UNDEFINED ? ascii("") : to_string(v)));
}
static yk builtin_text_encoder(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s, (void)argc, (void)argv;
  yk o = yk_object_of(0, NULL, NULL);
  own_set((yk_object *)PTR(o), ascii("encoding"), ascii("utf-8"));
  own_set((yk_object *)PTR(o), ascii("encode"), yk_closure_new(text_encoder_encode, 1, 0, NULL));
  return o;
}

/* A property of a buffer or a view: its element, or its own accessors' values; 0 if none. */
static inline __attribute__((always_inline)) int typed_fast_get(yk obj, uint32_t i, yk *out) {
  /* The caller knows obj is a typed array (an object of its kind). */
  yk_view *t = (yk_view *)((yk_object *)PTR(obj))->ext;
  if (i >= t->length) return 0;
  /* The common element types at once; the others through ta_get. */
  uint8_t *p = ((yk_buffer *)((yk_object *)PTR(t->buffer))->ext)->data + t->offset;
  if (t->type == TA_U32) {
    uint32_t x;
    memcpy(&x, p + (size_t)i * 4, 4);
    return *out = yk_number(x), 1;
  }
  if (t->type == TA_U8) return *out = yk_number(p[i]), 1;
  *out = ta_get(t, i);
  return 1;
}
static int buffer_get(yk obj, yk key, yk *out) {
  yk_view *t = typed_of(obj);
  if (t != NULL) {
    uint32_t i;
    int k = typed_index(key, t->length, &i);
    if (k == 1) return *out = ta_get(t, i), 1;
    if (k == -1) return *out = YK_UNDEFINED, 1;
    if (key_is(key, "length")) return *out = yk_number(t->length), 1;
    if (key_is(key, "byteLength")) return *out = yk_number((double)t->length * ta_size[t->type]), 1;
    if (key_is(key, "byteOffset")) return *out = yk_number(t->offset), 1;
    if (key_is(key, "buffer")) return *out = t->buffer, 1;
    if (key_is(key, "BYTES_PER_ELEMENT")) return *out = yk_number(ta_size[t->type]), 1;
    return 0;
  }
  yk_buffer *b = buffer_of(obj);
  if (b != NULL && key_is(key, "byteLength")) return *out = yk_number(b->len), 1;
  yk_view *d = dataview_of(obj);
  if (d != NULL) {
    if (key_is(key, "byteLength")) return *out = yk_number(d->length), 1;
    if (key_is(key, "byteOffset")) return *out = yk_number(d->offset), 1;
    if (key_is(key, "buffer")) return *out = d->buffer, 1;
  }
  return 0;
}
/* A write to a typed array's element (or a numeric key that names none: nothing); 0 otherwise. */
static int buffer_set(yk obj, yk key, yk value) {
  yk_view *t = typed_of(obj);
  if (t == NULL) return 0;
  uint32_t i;
  int k = typed_index(key, t->length, &i);
  if (k == 1) ta_set(t, i, value);
  else if (k == -1) {
    /* Still converted (which may throw), as IntegerIndexedElementSet does. */
    uint8_t tmp[8];
    ta_encode(t->type, value, tmp);
  }
  return k != 0;
}

/* RelativeIndex as slice and fill clamp it. */
static uint32_t clamp_relative(yk v, uint32_t len, uint32_t dflt) {
  if (v == YK_UNDEFINED) return dflt;
  double d = to_number(v);
  if (d != d) d = 0;
  d = trunc(d);
  if (d < 0) d = d + len < 0 ? 0 : d + len;
  return d > len ? len : (uint32_t)d;
}

static int dataview_method(yk_view *d, yk key, uint64_t argc, const yk *argv, yk *out) {
  static const char *const get_names[TA_COUNT] = {"getInt8",   "getUint8",   NULL,         "getInt16",
                                                  "getUint16", "getInt32",   "getUint32",  "getFloat32",
                                                  "getFloat64", "getBigInt64", "getBigUint64"};
  static const char *const set_names[TA_COUNT] = {"setInt8",   "setUint8",   NULL,         "setInt16",
                                                  "setUint16", "setInt32",   "setUint32",  "setFloat32",
                                                  "setFloat64", "setBigInt64", "setBigUint64"};
  /* get<Type> or set<Type>: the prefix once, then the type's name (#1370: a hash's every word). */
  if (!is_string(key)) return 0;
  yk_string *ks = str(key);
  if (ks->len < 7 || ks->len > 12 || ks->units[1] != 'e' || ks->units[2] != 't' ||
      (ks->units[0] != 'g' && ks->units[0] != 's'))
    return 0;
  int is_set = ks->units[0] == 's';
  for (int32_t type = 0; type < TA_COUNT; type++) {
    const char *name = get_names[type];
    static const uint8_t name_len[TA_COUNT] = {7, 8, 0, 8, 9, 8, 9, 10, 10, 11, 12};
    if (name == NULL || name_len[type] != ks->len) continue;
    uint32_t k = 3;
    while (k < ks->len && ks->units[k] == (unsigned char)name[k]) k++;
    if (k != ks->len) continue;
    int get = !is_set, set = is_set;
    (void)set_names;
    uint32_t at = to_index(argc > 0 ? argv[0] : YK_UNDEFINED, "Offset is outside the bounds of the DataView");
    yk little = argc > (uint64_t)(get ? 1 : 2) ? argv[get ? 1 : 2] : YK_UNDEFINED;
    uint8_t bytes[8];
    if (set) ta_encode(type, argc > 1 ? argv[1] : YK_UNDEFINED, bytes);
    uint32_t size = ta_size[type];
    if ((uint64_t)at + size > d->length) range_error("Offset is outside the bounds of the DataView");
    uint8_t *p = buffer_of(d->buffer)->data + d->offset + at;
    int le = yk_truthy(little);
    if (set) {
      for (uint32_t i = 0; i < size; i++) p[i] = bytes[le ? i : size - 1 - i];
      return *out = YK_UNDEFINED, 1;
    }
    for (uint32_t i = 0; i < size; i++) bytes[le ? i : size - 1 - i] = p[i];
    yk_view tmp = {0, 0, 1, type};
    (void)tmp;
    uint8_t *saved = bytes;
    switch (type) {
    case TA_I8: return *out = yk_number(*(int8_t *)saved), 1;
    case TA_U8: return *out = yk_number(*saved), 1;
    case TA_I16: { int16_t x; memcpy(&x, saved, 2); return *out = yk_number(x), 1; }
    case TA_U16: { uint16_t x; memcpy(&x, saved, 2); return *out = yk_number(x), 1; }
    case TA_I32: { int32_t x; memcpy(&x, saved, 4); return *out = yk_number(x), 1; }
    case TA_U32: { uint32_t x; memcpy(&x, saved, 4); return *out = yk_number(x), 1; }
    case TA_F32: { float x; memcpy(&x, saved, 4); return *out = yk_number(x), 1; }
    case TA_F64: { double x; memcpy(&x, saved, 8); return *out = yk_number(x), 1; }
    case TA_BI64: { int64_t x; memcpy(&x, saved, 8); return *out = big_from_i64(x), 1; }
    default: { uint64_t x; memcpy(&x, saved, 8); return *out = big_from_u64(x, 0), 1; }
    }
  }
  return 0;
}

/* The methods of a buffer, a typed array and a DataView; 0 if the key is none of them. */
static int buffer_method(yk recv, yk key, uint64_t argc, const yk *argv, yk *out) {
  yk a0 = argc > 0 ? argv[0] : YK_UNDEFINED, a1 = argc > 1 ? argv[1] : YK_UNDEFINED;
  yk_buffer *b = buffer_of(recv);
  if (b != NULL && key_is(key, "slice")) {
    uint32_t from = clamp_relative(a0, b->len, 0), to = clamp_relative(a1, b->len, b->len);
    uint32_t n = to > from ? to - from : 0;
    yk r = new_buffer(n);
    memcpy(buffer_of(r)->data, b->data + from, n);
    return *out = r, 1;
  }
  yk_view *d = dataview_of(recv);
  if (d != NULL) return dataview_method(d, key, argc, argv, out);
  yk_view *t = typed_of(recv);
  if (t == NULL) return 0;
  uint32_t len = t->length, size = ta_size[t->type];
  if (key_is(key, "subarray")) {
    uint32_t from = clamp_relative(a0, len, 0), to = clamp_relative(a1, len, len);
    uint32_t n = to > from ? to - from : 0;
    return *out = new_typed(t->type, t->buffer, t->offset + from * size, n), 1;
  }
  if (key_is(key, "slice")) {
    uint32_t from = clamp_relative(a0, len, 0), to = clamp_relative(a1, len, len);
    uint32_t n = to > from ? to - from : 0;
    yk r = new_typed(t->type, new_buffer(n * size), 0, n);
    memcpy(view_bytes(typed_of(r)), view_bytes(t) + (size_t)from * size, (size_t)n * size);
    return *out = r, 1;
  }
  if (key_is(key, "set")) {
    double off = a1 == YK_UNDEFINED ? 0 : trunc(to_number(a1));
    if (off != off) off = 0;
    if (off < 0) range_error("offset is out of bounds");
    yk_view *src = typed_of(a0);
    if (src != NULL) {
      if (is_bigint_type(src->type) != is_bigint_type(t->type)) type_error("Content types of the typed arrays differ");
      if (off + src->length > len) range_error("offset is out of bounds");
      /* Read every element first: the source may share the target's buffer. */
      yk_array *items = typed_items(src);
      for (uint32_t i = 0; i < items->len; i++) ta_set(t, (uint32_t)off + i, items->items[i]);
      return *out = YK_UNDEFINED, 1;
    }
    if (is_nullish(a0)) type_error("Cannot convert undefined or null to object");
    yk lv = yk_get(a0, ascii("length"));
    double n = lv == YK_UNDEFINED ? 0 : to_number(lv);
    if (n != n) n = 0;
    if (off + n > len) range_error("offset is out of bounds");
    for (uint32_t i = 0; i < (uint32_t)n; i++) ta_set(t, (uint32_t)off + i, yk_get(a0, yk_number(i)));
    return *out = YK_UNDEFINED, 1;
  }
  if (key_is(key, "fill")) {
    uint8_t tmp[8];
    ta_encode(t->type, a0, tmp);
    uint32_t from = clamp_relative(a1, len, 0), to = clamp_relative(argc > 2 ? argv[2] : YK_UNDEFINED, len, len);
    for (uint32_t i = from; i < to; i++) memcpy(view_bytes(t) + (size_t)i * size, tmp, size);
    return *out = recv, 1;
  }
  if (key_is(key, "join") || key_is(key, "toString")) {
    yk sep = key_is(key, "join") && a0 != YK_UNDEFINED ? to_string(a0) : ascii(",");
    return *out = array_join(typed_items(t), str(sep)), 1;
  }
  if (key_is(key, "at")) {
    double d0 = a0 == YK_UNDEFINED ? 0 : trunc(to_number(a0));
    if (d0 != d0) d0 = 0;
    if (d0 < 0) d0 += len;
    return *out = d0 < 0 || d0 >= len ? YK_UNDEFINED : ta_get(t, (uint32_t)d0), 1;
  }
  if (key_is(key, "indexOf") || key_is(key, "includes")) {
    int inc = key_is(key, "includes");
    for (uint32_t i = clamp_relative(a1, len, 0); i < len; i++) {
      yk e = ta_get(t, i);
      if (inc ? same_value_zero(e, a0) : strict_equal(e, a0)) return *out = inc ? YK_TRUE : yk_number(i), 1;
    }
    return *out = inc ? YK_FALSE : yk_number(-1), 1;
  }
  if (key_is(key, "reverse")) {
    yk_array *items = typed_items(t);
    for (uint32_t i = 0; i < len; i++) ta_set(t, i, items->items[len - 1 - i]);
    return *out = recv, 1;
  }
  if (key_is(key, "forEach") || key_is(key, "map") || key_is(key, "every") || key_is(key, "some") ||
      key_is(key, "reduce")) {
    if (!is_closure(a0)) type_error("the callback is not a function");
    if (key_is(key, "reduce")) {
      uint32_t i = 0;
      yk acc;
      if (argc > 1) acc = a1;
      else {
        if (len == 0) type_error("Reduce of empty array with no initial value");
        acc = ta_get(t, i++);
      }
      for (; i < len; i++) {
        yk args[4] = {acc, ta_get(t, i), yk_number(i), recv};
        acc = call_value(a0, YK_UNDEFINED, 4, args);
      }
      return *out = acc, 1;
    }
    int map = key_is(key, "map"), every = key_is(key, "every"), some = key_is(key, "some");
    yk r = map ? new_typed(t->type, new_buffer(len * size), 0, len) : YK_UNDEFINED;
    for (uint32_t i = 0; i < len; i++) {
      yk args[3] = {ta_get(t, i), yk_number(i), recv};
      yk got = call_value(a0, a1, 3, args);
      if (map) ta_set(typed_of(r), i, got);
      if (every && !yk_truthy(got)) return *out = YK_FALSE, 1;
      if (some && yk_truthy(got)) return *out = YK_TRUE, 1;
    }
    return *out = map ? r : every ? YK_TRUE : some ? YK_FALSE : YK_UNDEFINED, 1;
  }
  return 0;
}

static yk_array *typed_items_v(yk v) { return typed_items(typed_of(v)); }
static yk buffer_primitive(yk v) { return array_join(typed_items(typed_of(v)), str(ascii(","))); }

/* --- a program's entry: process, console, JSON.parse (#1333) ------------------------------------
 *
 * A program built by `yakcc build --native` runs its entry module from a generated main:
 * yk_main_begin(argc, argv), the entry's initializer, then yk_main_end(), which runs the jobs left and
 * gives the exit code (process.exitCode, else 0). An exception nothing catches ends the program with
 * exit code 1, as Node's does. These are the interim layer-0 primitives over the C library; #1365
 * moves them onto the system-call leaf.
 */

static int program_mode = 0;
static int program_argc = 0;
static char **program_argv = NULL;
static yk process_value = 0;

/* A string's UTF-8 bytes written to a stream (a lone surrogate as U+FFFD, as Node writes it). */
static void write_utf8(FILE *f, yk_string *s) {
  yk bytes = utf8_bytes(s);
  yk_view *t = typed_of(bytes);
  fwrite(view_bytes(t), 1, t->length, f);
}

/* A primitive as util.inspect writes it; an object stops the program (not in the runtime yet). */
static yk inspect_primitive(yk v, int top) {
  if (is_string(v)) {
    if (top) return v;
    type_error("console formatting of a string inside a structure is not in the native runtime yet");
  }
  if (is_number(v)) {
    double d = num(v);
    if (d == 0 && 1 / d < 0) return ascii("-0");
    return number_to_string(d);
  }
  if (is_bigint(v)) return concat(str(big_to_string_v(v)), str(ascii("n")));
  if (is_reference(v)) {
    fputs("TypeError: console formatting of an object is not in the native runtime yet\n", stderr);
    exit(70);
  }
  return to_string(v);
}

/* util.format: %s %d %i %f %j %o %O %c %% in a first string argument, then the rest, spaced. */
static yk format_args(uint64_t argc, const yk *argv) {
  yk out = ascii("");
  uint64_t next = 0;
  if (argc > 0 && is_string(argv[0])) {
    yk_string *f = str(argv[0]);
    next = 1;
    uint32_t last = 0;
    for (uint32_t i = 0; i + 1 < f->len; i++) {
      if (f->units[i] != '%') continue;
      uint16_t c = f->units[i + 1];
      yk piece = 0;
      if (c == '%') piece = ascii("%");
      else if (next < argc && (c == 's' || c == 'd' || c == 'i' || c == 'f' || c == 'j' || c == 'o' ||
                               c == 'O' || c == 'c')) {
        yk a = argv[next++];
        if (c == 's') piece = is_string(a) ? a : inspect_primitive(a, 1);
        else if (c == 'd') piece = is_bigint(a) ? inspect_primitive(a, 1) : is_reference(a) ? ascii("NaN") : inspect_primitive(yk_number(to_number(a)), 1);
        else if (c == 'i') {
          double d = is_reference(a) ? NAN : trunc(to_number(a));
          piece = is_bigint(a) ? inspect_primitive(a, 1) : inspect_primitive(yk_number(d), 1);
        } else if (c == 'f') piece = inspect_primitive(yk_number(string_to_number(str(to_string(a)))), 1);
        else if (c == 'j') piece = yk_call_method(yk_global("JSON", 4), "stringify", 9, 1, &a);
        else if (c == 'c') piece = ascii("");
        else piece = inspect_primitive(a, 1);
      }
      if (piece == 0) continue;
      yk_string *head = new_string(i - last);
      memcpy(head->units, f->units + last, (size_t)(i - last) * 2);
      out = concat(str(out), head);
      out = concat(str(out), str(piece));
      last = i + 2;
      i++;
    }
    yk_string *tail = new_string(f->len - last);
    memcpy(tail->units, f->units + last, (size_t)(f->len - last) * 2);
    out = concat(str(out), tail);
  }
  for (uint64_t k = next; k < argc; k++) {
    if (k > 0) out = concat(str(out), str(ascii(" ")));
    out = concat(str(out), str(inspect_primitive(argv[k], 1)));
  }
  return out;
}
static yk console_out(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  write_utf8(stdout, str(format_args(argc, argv)));
  fputc('\n', stdout);
  return YK_UNDEFINED;
}
static yk console_err(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  fflush(stdout);
  write_utf8(stderr, str(format_args(argc, argv)));
  fputc('\n', stderr);
  return YK_UNDEFINED;
}
static yk stream_write(FILE *f, uint64_t argc, const yk *argv) {
  yk v = argc > 0 ? argv[0] : YK_UNDEFINED;
  yk_view *t = typed_of(v);
  if (t != NULL) fwrite(view_bytes(t), 1, (size_t)t->length * ta_size[t->type], f);
  else if (is_string(v)) write_utf8(f, str(v));
  else type_error("The \"chunk\" argument must be of type string or an instance of Buffer or Uint8Array");
  return YK_TRUE;
}
static yk stdout_write(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return stream_write(stdout, argc, argv);
}
static yk stderr_write(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  fflush(stdout);
  return stream_write(stderr, argc, argv);
}
static int exit_code_of(void) {
  if (process_value == 0) return 0;
  yk code = yk_get(process_value, ascii("exitCode"));
  if (code == YK_UNDEFINED) return 0;
  return (int)(to_int32(code) & 0xff);
}
static yk process_exit(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  if (argc > 0 && argv[0] != YK_UNDEFINED) yk_set(process_value, ascii("exitCode"), argv[0]);
  fflush(stdout);
  fflush(stderr);
  exit(exit_code_of());
}

static yk with_one_method(const char *name, yk_code code) {
  yk o = yk_object_of(0, NULL, NULL);
  own_set((yk_object *)PTR(o), ascii(name), yk_closure_new(code, 0, 0, NULL));
  return o;
}

static yk process_global(void) {
  if (process_value != 0) return process_value;
  extern char **environ;
  yk p = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(p);
  /* argv: Node's is [node, script, ...args]; a native program is its own interpreter and script. */
  yk_array *args = new_array(4);
  const char *self = program_argc > 0 ? program_argv[0] : "yakcc-native";
  push(args, ascii(self));
  push(args, ascii(self));
  for (int i = 1; i < program_argc; i++) push(args, ascii(program_argv[i]));
  own_set(o, ascii("argv"), BOX(T_ARRAY, args));
  yk env = yk_object_of(0, NULL, NULL);
  for (char **e = environ; e != NULL && *e != NULL; e++) {
    const char *eq = strchr(*e, '=');
    if (eq == NULL) continue;
    own_set((yk_object *)PTR(env), yk_string_utf8(*e, (uint64_t)(eq - *e)), ascii(eq + 1));
  }
  own_set(o, ascii("env"), env);
  own_set(o, ascii("platform"), ascii("linux"));
  own_set(o, ascii("arch"), ascii(sizeof(void *) == 8 ? (
#if defined(__aarch64__)
                                       "arm64"
#else
                                       "x64"
#endif
                                       ) : "ia32"));
  /* versions: the Node library the program is built from; no OpenSSL (no crypto binding yet). */
  {
    yk v = yk_object_of(0, NULL, NULL);
    own_set((yk_object *)PTR(v), ascii("node"), ascii("22.23.5"));
    own_set((yk_object *)PTR(v), ascii("yakcc"), ascii("native"));
    own_set(o, ascii("versions"), v);
    own_set(o, ascii("version"), ascii("v22.23.5"));
  }
  own_set(o, ascii("exit"), yk_closure_new(process_exit, 0, 0, NULL));
  own_set(o, ascii("stdout"), with_one_method("write", stdout_write));
  own_set(o, ascii("stderr"), with_one_method("write", stderr_write));
  return process_value = p;
}
static yk console_global(void) {
  static yk c = 0;
  if (c != 0) return c;
  c = yk_object_of(0, NULL, NULL);
  yk_object *o = (yk_object *)PTR(c);
  const char *outs[3] = {"log", "info", "debug"};
  const char *errs[2] = {"error", "warn"};
  for (int i = 0; i < 3; i++) own_set(o, ascii(outs[i]), yk_closure_new(console_out, 0, 0, NULL));
  for (int i = 0; i < 2; i++) own_set(o, ascii(errs[i]), yk_closure_new(console_err, 0, 0, NULL));
  return c;
}

/* --- JSON.parse (ECMA-262 25.5.1): the strict grammar, else a SyntaxError; then the reviver --- */

typedef struct {
  yk_string *s;
  uint32_t i;
} json_reader;
static _Noreturn void json_error(json_reader *r) {
  (void)r;
  yk_throw(make_error("SyntaxError", ascii("Unexpected token in JSON")));
}
static void json_ws(json_reader *r) {
  while (r->i < r->s->len) {
    uint16_t c = r->s->units[r->i];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
    r->i++;
  }
}
static int json_word(json_reader *r, const char *w) {
  size_t n = strlen(w);
  if (r->i + n > r->s->len) return 0;
  for (size_t k = 0; k < n; k++)
    if (r->s->units[r->i + k] != (uint16_t)w[k]) return 0;
  r->i += (uint32_t)n;
  return 1;
}
static yk json_string(json_reader *r) {
  r->i++; /* the opening quote */
  /* With no escape before its closing quote: its units copied at once. */
  for (uint32_t j = r->i; j < r->s->len; j++) {
    uint16_t c = r->s->units[j];
    if (c == '\\' || c < 0x20) break;
    if (c == '"') {
      yk_string *s = new_string(j - r->i);
      memcpy(s->units, r->s->units + r->i, (size_t)(j - r->i) * 2);
      r->i = j + 1;
      return string_of(s);
    }
  }
  yk_array *units = new_array(8);
  for (;;) {
    if (r->i >= r->s->len) json_error(r);
    uint16_t c = r->s->units[r->i++];
    if (c == '"') break;
    if (c < 0x20) json_error(r);
    if (c != '\\') {
      push(units, yk_number(c));
      continue;
    }
    if (r->i >= r->s->len) json_error(r);
    uint16_t e = r->s->units[r->i++];
    uint16_t out;
    switch (e) {
    case '"': out = '"'; break;
    case '\\': out = '\\'; break;
    case '/': out = '/'; break;
    case 'b': out = 8; break;
    case 'f': out = 12; break;
    case 'n': out = 10; break;
    case 'r': out = 13; break;
    case 't': out = 9; break;
    case 'u': {
      if (r->i + 4 > r->s->len) json_error(r);
      out = 0;
      for (int k = 0; k < 4; k++) {
        uint16_t h = r->s->units[r->i++];
        int d = h >= '0' && h <= '9' ? h - '0' : h >= 'a' && h <= 'f' ? h - 'a' + 10 : h >= 'A' && h <= 'F' ? h - 'A' + 10 : -1;
        if (d < 0) json_error(r);
        out = (uint16_t)(out * 16 + d);
      }
      break;
    }
    default: json_error(r);
    }
    push(units, yk_number(out));
  }
  yk_string *s = new_string(units->len);
  for (uint32_t k = 0; k < units->len; k++) s->units[k] = (uint16_t)num(units->items[k]);
  return string_of(s);
}
static yk json_number(json_reader *r) {
  uint32_t start = r->i;
  if (r->i < r->s->len && r->s->units[r->i] == '-') r->i++;
  if (r->i >= r->s->len) json_error(r);
  if (r->s->units[r->i] == '0') r->i++;
  else if (r->s->units[r->i] >= '1' && r->s->units[r->i] <= '9')
    while (r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9') r->i++;
  else
    json_error(r);
  if (r->i < r->s->len && r->s->units[r->i] == '.') {
    r->i++;
    if (!(r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9')) json_error(r);
    while (r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9') r->i++;
  }
  if (r->i < r->s->len && (r->s->units[r->i] == 'e' || r->s->units[r->i] == 'E')) {
    r->i++;
    if (r->i < r->s->len && (r->s->units[r->i] == '+' || r->s->units[r->i] == '-')) r->i++;
    if (!(r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9')) json_error(r);
    while (r->i < r->s->len && r->s->units[r->i] >= '0' && r->s->units[r->i] <= '9') r->i++;
  }
  char *buf = alloc(r->i - start + 1);
  for (uint32_t k = start; k < r->i; k++) buf[k - start] = (char)r->s->units[k];
  buf[r->i - start] = 0;
  return yk_number(strtod(buf, NULL));
}
static yk json_value(json_reader *r) {
  json_ws(r);
  if (r->i >= r->s->len) json_error(r);
  uint16_t c = r->s->units[r->i];
  if (c == '"') return json_string(r);
  if (c == '-' || (c >= '0' && c <= '9')) return json_number(r);
  if (json_word(r, "true")) return YK_TRUE;
  if (json_word(r, "false")) return YK_FALSE;
  if (json_word(r, "null")) return YK_NULL;
  if (c == '[') {
    r->i++;
    yk_array *a = new_array(4);
    json_ws(r);
    if (r->i < r->s->len && r->s->units[r->i] == ']') {
      r->i++;
      return BOX(T_ARRAY, a);
    }
    for (;;) {
      push(a, json_value(r));
      json_ws(r);
      if (r->i >= r->s->len) json_error(r);
      uint16_t d = r->s->units[r->i++];
      if (d == ']') return BOX(T_ARRAY, a);
      if (d != ',') json_error(r);
    }
  }
  if (c == '{') {
    r->i++;
    yk o = yk_object_of(0, NULL, NULL);
    json_ws(r);
    if (r->i < r->s->len && r->s->units[r->i] == '}') {
      r->i++;
      return o;
    }
    for (;;) {
      json_ws(r);
      if (r->i >= r->s->len || r->s->units[r->i] != '"') json_error(r);
      yk k = json_string(r);
      json_ws(r);
      if (r->i >= r->s->len || r->s->units[r->i++] != ':') json_error(r);
      own_set((yk_object *)PTR(o), k, json_value(r));
      json_ws(r);
      if (r->i >= r->s->len) json_error(r);
      uint16_t d = r->s->units[r->i++];
      if (d == '}') return o;
      if (d != ',') json_error(r);
    }
  }
  json_error(r);
}
/* InternalizeJSONProperty: the holder's value at name, its elements' or properties' revived first
   (one revived to undefined deleted; an array element set to undefined: no holes here). */
static yk json_revive(yk holder, yk name, yk reviver) {
  yk val = yk_get(holder, name);
  if (is_array(val)) {
    yk_array *a = arr(val);
    for (uint32_t i = 0; i < a->len; i++) a->items[i] = json_revive(val, to_string(yk_number(i)), reviver);
  } else if (is_object(val)) {
    yk_array *keys = enumerable_keys((yk_object *)PTR(val));
    for (uint32_t i = 0; i < keys->len; i++) {
      yk e = json_revive(val, keys->items[i], reviver);
      if (e == YK_UNDEFINED) yk_delete(val, keys->items[i]);
      else own_set((yk_object *)PTR(val), keys->items[i], e);
    }
  }
  yk args[2] = {name, val};
  return call_value(reviver, holder, 2, args);
}
static yk builtin_json_parse(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  json_reader r = {str(to_string(argc > 0 ? argv[0] : YK_UNDEFINED)), 0};
  yk v = json_value(&r);
  json_ws(&r);
  if (r.i != r.s->len) json_error(&r);
  if (argc > 1 && is_closure(argv[1])) {
    yk root = yk_object_of(0, NULL, NULL);
    own_set((yk_object *)PTR(root), ascii(""), v);
    return json_revive(root, ascii(""), argv[1]);
  }
  return v;
}

/* The generated main's: the arguments, and what an uncaught exception does. */
void yk_main_begin(int argc, char **argv) {
  program_mode = 1;
  program_argc = argc;
  program_argv = argv;
}
int yk_main_end(void) {
  yk_drain();
  fflush(stdout);
  fflush(stderr);
  return exit_code_of();
}

/* --- C's memory: the memory leaves raised C lowers to (#1363, DEC-DUC-OPERATIONS-AS-ATOMS-001) ---
 *
 * One flat, byte-addressed memory, as raise-c's createCMemory defines it: an address is an integer;
 * a region is allocated aligned to max(16, align) after the last one (with a 16-byte gap: one past a
 * region's end is in no other), its size rounded up to 16 and zeroed. Addresses only grow, so a
 * freed region's are never reused and a stale pointer traps. Loads and stores are little-endian and
 * trap outside a live region, and a store traps on constant data (`__ykData`: one region per
 * distinct content). A trap is an Error, "memory trap: …", as the JavaScript definition throws.
 */

typedef struct {
  uint64_t base;
  uint32_t len;
  int32_t constant, live;
  uint8_t *bytes;
} c_region;
static c_region *c_regions = NULL;
static uint32_t c_nregions = 0, c_capregions = 0;
/* The last region an access found: most accesses are to it. */
static uint32_t c_last = 0, c_prev = 0;
/* It, as the lowered code's inline loads and stores check it (#1369): its base, its length (0 when
   there is none), its bytes, and whether it may be written. */
uint64_t yk_mcache_base = 0;
uint64_t yk_mcache_len = 0;
uint8_t *yk_mcache_bytes = NULL;
uint64_t yk_mcache_writable = 0;
/* The lowered code's per-access-site caches (#1369) hold a region's base, length and bytes. The 16
   bytes before a region's bytes hold its base while it lives (0 once freed, a new region's when the
   bytes are reused), so a site that hit a freed region misses. Bytes handed back to the C library
   (a large region's) change this epoch instead, which every site's cache holds. */
uint64_t yk_mcache_epoch = 1;
/* The region cached before the last: a callee's accesses to its caller's frame hit it. */
uint64_t yk_mcache2_base = 0;
uint64_t yk_mcache2_len = 0;
uint8_t *yk_mcache2_bytes = NULL;
uint64_t yk_mcache2_writable = 0;
static void c_cache(c_region *r) {
  if (yk_mcache_bytes != r->bytes) {
    yk_mcache2_base = yk_mcache_base;
    yk_mcache2_len = yk_mcache_len;
    yk_mcache2_bytes = yk_mcache_bytes;
    yk_mcache2_writable = yk_mcache_writable;
  }
  yk_mcache_base = r->base;
  yk_mcache_len = r->len;
  yk_mcache_bytes = r->bytes;
  yk_mcache_writable = !r->constant;
}
static uint64_t c_next = 0x10000;
static yk c_data_keys = 0; /* an object: a constant's content, to its address */

static _Noreturn void c_trap(yk message) {
  yk_throw(make_error("Error", concat(str(ascii("memory trap: ")), str(message))));
}
static yk hex_of(double a) { return number_to_radix(a, 16); }

/* Freed regions' bytes, by size (16 to 4096, in steps of 16), for the next region of that size: a
   region's addresses are never reused, but its bytes may be (zeroed again). */
static uint8_t *c_free_bytes[257];
static uint8_t *c_bytes(uint32_t len, uint64_t base) {
  uint8_t *p;
  if (len <= 4096 && c_free_bytes[len / 16] != NULL) {
    p = c_free_bytes[len / 16];
    c_free_bytes[len / 16] = *(uint8_t **)p;
    memset(p, 0, len);
  } else {
    uint8_t *block = calloc((size_t)len + 16, 1);
    if (block == NULL) {
      fputs("out of memory\n", stderr);
      exit(71);
    }
    p = block + 16;
  }
  ((uint64_t *)p)[-2] = base;
  return p;
}
static void c_release(uint8_t *p, uint32_t len) {
  ((uint64_t *)p)[-2] = 0;
  if (len <= 4096) {
    *(uint8_t **)p = c_free_bytes[len / 16];
    c_free_bytes[len / 16] = p;
  } else {
    yk_mcache_epoch++;
    free(p - 16);
  }
}

static uint64_t c_alloc(double size, double align, int constant) {
  double a = align > 16 ? align : 16;
  uint64_t al = (uint64_t)a;
  /* A power-of-two alignment (every C type's) is a mask; an integral size below 2^32 rounds as an
     integer. Anything else takes the general arithmetic, with the same results. */
  uint64_t base = (al & (al - 1)) == 0 ? (c_next + al - 1) & ~(al - 1) : (c_next + al - 1) / al * al;
  uint32_t len;
  if (size >= 0 && size < 4294967280.0 && (double)(uint64_t)size == size) {
    uint64_t n = ((uint64_t)size + 15) & ~(uint64_t)15;
    len = (uint32_t)(n > 16 ? n : 16);
  } else {
    double n = ceil(size / 16) * 16;
    len = (uint32_t)(n > 16 ? n : 16);
  }
  if (c_nregions == c_capregions) {
    c_capregions = c_capregions == 0 ? 64 : c_capregions * 2;
    c_region *grown = alloc((size_t)c_capregions * sizeof(c_region));
    if (c_nregions > 0) memcpy(grown, c_regions, (size_t)c_nregions * sizeof(c_region));
    c_regions = grown;
  }
  uint8_t *bytes = c_bytes(len, base);
  c_regions[c_nregions++] = (c_region){base, len, constant, 1, bytes};
  c_next = base + len + 16;
  /* A new region is the one its first accesses are to. */
  c_prev = c_last;
  c_last = c_nregions - 1;
  c_cache(&c_regions[c_last]);
  return base;
}
static c_region *c_region_of(double a, uint32_t n, int write) {
  /* An integral address below 2^53 is compared as an integer; anything else is no region's. */
  if (a >= 0 && a < 9007199254740992.0) {
    uint64_t u = (uint64_t)a;
    if ((double)u == a) {
      /* The last two regions found: a function alternating between two arrays hits one of them. */
      uint32_t recent[2] = {c_last, c_prev};
      for (int k = 0; k < 2; k++) {
        if (recent[k] >= c_nregions) continue;
        c_region *r = &c_regions[recent[k]];
        if (u - r->base < r->len && u - r->base + n <= r->len && r->live && !(write && r->constant)) {
          if (k == 1) {
            c_prev = c_last;
            c_last = recent[1];
          }
          c_cache(r);
          return r;
        }
      }
      uint32_t lo = 0, hi = c_nregions;
      while (lo < hi) {
        uint32_t mid = (lo + hi) / 2;
        c_region *r = &c_regions[mid];
        if (u < r->base) hi = mid;
        else if (u - r->base >= r->len) lo = mid + 1;
        else {
          if (!r->live || u - r->base + n > r->len || (write && r->constant)) break;
          c_prev = c_last;
          c_last = mid;
          c_cache(r);
          return r;
        }
      }
    }
  }
  if (!(a == a && !isinf(a) && trunc(a) == a)) c_trap(concat(str(ascii("address ")), str(number_to_string(a))));
  char what[48];
  snprintf(what, sizeof what, "%s of %u at 0x", write ? "store" : "load", n);
  c_trap(concat(str(ascii(what)), str(hex_of(a))));
}
static uint8_t *c_at(yk addr, uint32_t n, int write) {
  /* An address is a number as it is (Number.isInteger, no conversion): anything else traps with
     its string, as the definition's template does. */
  if (addr >= ((yk)T_SPECIAL << 48)) c_trap(concat(str(ascii("address ")), str(to_string(addr))));
  double a = to_number(addr);
  c_region *r = c_region_of(a, n, write);
  return r->bytes + (uint64_t)(a - (double)r->base);
}

yk yk_leaf_alloc(yk size, yk align) { return yk_number((double)c_alloc(to_number(size), to_number(align), 0)); }
/* Function pointers (raise-c's __ykFnAddr/__ykFnAt): a function's address is 0x7f0000000000 plus
 * 16 per function, in the order first taken (as createCMemory's), the same for every use of the
 * function, outside the data; a call through a pointer looks it up. */
static yk *fn_values;
static uint64_t *fn_addrs;
static size_t fn_count, fn_cap;
yk yk_leaf_fn_addr(yk f) {
  for (size_t i = 0; i < fn_count; i++)
    if (fn_values[i] == f) return yk_number((double)fn_addrs[i]);
  if (fn_count == fn_cap) {
    fn_cap = fn_cap == 0 ? 16 : fn_cap * 2;
    fn_values = realloc(fn_values, fn_cap * sizeof *fn_values);
    fn_addrs = realloc(fn_addrs, fn_cap * sizeof *fn_addrs);
    if (fn_values == NULL || fn_addrs == NULL) abort();
  }
  fn_values[fn_count] = f;
  fn_addrs[fn_count] = 0x7f0000000000ULL + 16 * (uint64_t)fn_count;
  return yk_number((double)fn_addrs[fn_count++]);
}
yk yk_leaf_fn_at(yk a) {
  uint64_t x = (uint64_t)to_number(a);
  for (size_t i = 0; i < fn_count; i++)
    if (fn_addrs[i] == x) return fn_values[i];
  type_error("memory trap: a call through a pointer that is no function's");
  return YK_UNDEFINED;
}
static void c_free(double a);
yk yk_leaf_free(yk addr) {
  c_free(to_number(addr));
  return YK_UNDEFINED;
}
/* A frame's block, as the lowered code allocates it (#1369): __ykAlloc of a constant integral size
   and alignment, with no boxing; the address is a number's bits. */
/* A span a function reads or writes through a pointer parameter (#1369): the bytes of
   [p, p + n) if one live region (writable, for `write`) of at most 4096 bytes holds them, with its
   header's address and its base, which the lowered code checks before each access; else NULL, with
   a header that never matches. Never traps: an access that would is the leaf's. */
static uint64_t c_no_header = 0;
uint8_t *yk_span(uint64_t pbits, uint64_t n, int32_t write, uint8_t **hdr, uint64_t *base) {
  *hdr = (uint8_t *)&c_no_header;
  *base = 1;
  if (pbits >= ((uint64_t)T_SPECIAL << 48)) return NULL;
  double a;
  memcpy(&a, &pbits, 8);
  if (!(a >= 0 && a < 9007199254740992.0)) return NULL;
  uint64_t u = (uint64_t)a;
  if ((double)u != a) return NULL;
  /* The caller's frame, most often: among the last regions made or found. */
  uint32_t recent[3] = {c_nregions - 1, c_last, c_prev};
  for (int k = 0; k < 3; k++) {
    if (recent[k] >= c_nregions) continue;
    c_region *r = &c_regions[recent[k]];
    if (u - r->base < r->len) {
      if (!r->live || u - r->base + n > r->len || (write && r->constant) || r->len > 4096) return NULL;
      *hdr = r->bytes - 16;
      *base = r->base;
      return r->bytes + (u - r->base);
    }
  }
  uint32_t lo = 0, hi = c_nregions;
  while (lo < hi) {
    uint32_t mid = (lo + hi) / 2;
    c_region *r = &c_regions[mid];
    if (u < r->base) hi = mid;
    else if (u - r->base >= r->len) lo = mid + 1;
    else {
      if (!r->live || u - r->base + n > r->len || (write && r->constant) || r->len > 4096) return NULL;
      *hdr = r->bytes - 16;
      *base = r->base;
      return r->bytes + (u - r->base);
    }
  }
  return NULL;
}
/* The bytes of the frame yk_frame_alloc made last: the lowered code's accesses inside it. */
uint8_t *yk_frame_bytes = NULL;
uint64_t yk_frame_alloc(uint64_t size, uint64_t align) {
  /* A small frame with freed bytes of its size at hand: c_alloc's steps, on integers, the bytes
     zeroed inline. Anything else is c_alloc's. */
  uint64_t al = align > 16 ? align : 16;
  uint32_t len = size <= 16 ? 16 : (uint32_t)((size + 15) & ~(uint64_t)15);
  if (len <= 4096 && c_nregions < c_capregions && c_free_bytes[len / 16] != NULL) {
    uint64_t base = (c_next + al - 1) & ~(al - 1);
    uint8_t *p = c_free_bytes[len / 16];
    c_free_bytes[len / 16] = *(uint8_t **)p;
    uint64_t *w = (uint64_t *)p;
    switch (len) { /* 16, 32, 48 or 64 bytes: stores, not a call */
    case 64: w[6] = 0; w[7] = 0; /* fall through */
    case 48: w[4] = 0; w[5] = 0; /* fall through */
    case 32: w[2] = 0; w[3] = 0; /* fall through */
    case 16: w[0] = 0; w[1] = 0; break;
    default: memset(p, 0, len);
    }
    ((uint64_t *)p)[-2] = base;
    c_regions[c_nregions++] = (c_region){base, len, 0, 1, p};
    c_next = base + len + 16;
    c_prev = c_last;
    c_last = c_nregions - 1;
    c_cache(&c_regions[c_last]);
    yk_frame_bytes = p;
    double d = (double)base;
    uint64_t bits;
    memcpy(&bits, &d, 8);
    return bits;
  }
  double a = (double)c_alloc((double)size, (double)align, 0);
  yk_frame_bytes = c_regions[c_nregions - 1].bytes;
  uint64_t bits;
  memcpy(&bits, &a, 8);
  return bits;
}
/* ToUint32 of a number (a store into a block whose address never escapes: its low bytes). */
uint32_t yk_double_to_uint32(double d) {
  if (!(d == d) || isinf(d)) return 0;
  if (d > -9.2e18 && d < 9.2e18) return (uint32_t)(int64_t)d;
  double r = fmod(trunc(d), 4294967296.0);
  return (uint32_t)(r < 0 ? r + 4294967296.0 : r);
}
/* An access of a block passed as its bytes and length (a `.raw` variant's argument) past its end. */
void yk_raw_trap(int64_t off, int64_t size) {
  char msg[96];
  snprintf(msg, sizeof msg, "%lld bytes at offset %lld of a block", (long long)size, (long long)off);
  c_trap(ascii(msg));
}
/* __ykFree of a number (a frame's block, most often), with no boxing. */
void yk_frame_free(uint64_t bits) {
  double a;
  memcpy(&a, &bits, 8);
  c_free(a);
}
static void c_free(double a) {
  if (a == 0) return;
  /* Frames are freed last-in, first-out: the last region, most often. */
  c_region *last = c_nregions > 0 ? &c_regions[c_nregions - 1] : NULL;
  c_region *r = last != NULL && last->live && (double)last->base == a ? last : c_region_of(a, 1, 0);
  if ((double)r->base != a || r->constant) c_trap(concat(str(ascii("free of 0x")), str(hex_of(a))));
  r->live = 0;
  if (yk_mcache_bytes == r->bytes) yk_mcache_len = 0;
  if (yk_mcache2_bytes == r->bytes) yk_mcache2_len = 0;
  c_release(r->bytes, r->len);
  r->bytes = NULL;
  /* A dead region traps as no region does, so the dead ones at the end leave the table (frames are
     freed last-in, first-out: the table stays as deep as the live ones). */
  while (c_nregions > 0 && !c_regions[c_nregions - 1].live) c_nregions--;
}
yk yk_leaf_load8(yk a) { return yk_number(*c_at(a, 1, 0)); }
yk yk_leaf_load16(yk a) {
  uint8_t *p = c_at(a, 2, 0);
  return yk_number(p[0] | (p[1] << 8));
}
yk yk_leaf_load32(yk a) {
  uint8_t *p = c_at(a, 4, 0);
  return yk_number((double)((uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24)));
}
static uint64_t c_le64(const uint8_t *p) {
  uint64_t x = 0;
  for (int i = 7; i >= 0; i--) x = (x << 8) | p[i];
  return x;
}
yk yk_leaf_load64(yk a) { return big_from_u64(c_le64(c_at(a, 8, 0)), 0); }

/* --- The system-call leaf and the thread pointer (#1365, layer 0) ---
 *
 * As raise-c's createCSystem defines them over C's memory: Linux x86-64's call numbers, for the
 * calls musl makes on behalf of malloc, stdio, time and exit. Arguments and the result are BigInts
 * (64-bit, signed). write and writev write the bytes of C's memory to the host's descriptor; an
 * anonymous mmap is a new region of whole pages; brk fails and mremap is refused (so malloc maps
 * and realloc copies); clock_gettime is the host's real-time clock; exit and exit_group end the
 * process; anything else is -ENOSYS.
 */
static void c_put(uint8_t *p, uint64_t x, int n);
static int64_t big_i64(yk v) { return (int64_t)big_low64(want_big(v)); }
static yk big_of_i64(int64_t x) { return x < 0 ? big_from_u64(-(uint64_t)x, 1) : big_from_u64((uint64_t)x, 0); }
static int64_t c_write(int64_t fd, double a, int64_t n) {
  if (n <= 0) return 0;
  c_region *r = c_region_of(a, (uint32_t)n, 0);
  uint8_t *p = r->bytes + (uint64_t)(a - (double)r->base);
  if (fd == 1) fflush(stdout);
  if (fd == 2) fflush(stderr);
  for (int64_t done = 0; done < n;) {
    ssize_t w = write((int)fd, p + done, (size_t)(n - done));
    if (w <= 0) break;
    done += w;
  }
  return n;
}
yk yk_leaf_syscall(yk nr, yk a, yk b, yk c, yk d, yk e, yk f) {
  (void)d;
  (void)f;
  switch (big_i64(nr)) {
  case 1: /* write(fd, buf, count) */
    return big_of_i64(c_write(big_i64(a), (double)big_i64(b), big_i64(c)));
  case 20: { /* writev(fd, iov, iovcnt): each iovec { base, len } */
    int64_t total = 0, iov = big_i64(b);
    for (int64_t i = 0; i < big_i64(c); i++) {
      uint64_t base = c_le64(c_at(yk_number((double)(iov + 16 * i)), 8, 0));
      uint64_t len = c_le64(c_at(yk_number((double)(iov + 16 * i + 8)), 8, 0));
      total += c_write(big_i64(a), (double)base, (int64_t)len);
    }
    return big_of_i64(total);
  }
  case 9: { /* mmap(addr, length, prot, flags, fd, offset): anonymous only, whole pages */
    if (big_i64(e) != -1) return big_of_i64(-38);
    double pages = ceil((double)big_i64(b) / 4096) * 4096;
    return big_of_i64((int64_t)c_alloc(pages, 4096, 0));
  }
  case 11: /* munmap */
  case 12: /* brk: no break */
    return big_of_i64(0);
  case 25: /* mremap: not offered */
    return big_of_i64(-12);
  case 28: /* madvise */
  case 3:  /* close */
  case 14: /* rt_sigprocmask */
    return big_of_i64(0);
  case 16: /* ioctl: no terminal */
    return big_of_i64(-25);
  case 8: /* lseek: not seekable */
    return big_of_i64(-29);
  case 39:  /* getpid */
  case 186: /* gettid */
    return big_of_i64(1);
  case 228: { /* clock_gettime(clock, timespec) */
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    double at = (double)big_i64(b);
    c_put(c_at(yk_number(at), 8, 1), (uint64_t)ts.tv_sec, 8);
    c_put(c_at(yk_number(at + 8), 8, 1), (uint64_t)ts.tv_nsec, 8);
    return big_of_i64(0);
  }
  case 60:  /* exit */
  case 231: /* exit_group */
    fflush(stdout);
    fflush(stderr);
    exit((int)big_i64(a));
  default:
    return big_of_i64(-38);
  }
}
/* The thread's control block: zeroed, its first word its own address. */
yk yk_leaf_tp(void) {
  static uint64_t tp = 0;
  if (tp == 0) {
    tp = c_alloc(4096, 64, 0);
    c_put(c_at(yk_number((double)tp), 8, 1), tp, 8);
  }
  return big_from_u64(tp, 0);
}
yk yk_leaf_load_f64(yk a) {
  uint64_t x = c_le64(c_at(a, 8, 0));
  double d;
  memcpy(&d, &x, 8);
  return yk_number(d);
}
yk yk_leaf_load_f32(yk a) {
  uint8_t *p = c_at(a, 4, 0);
  uint32_t x = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
  float f;
  memcpy(&f, &x, 4);
  return yk_number(f);
}
static void c_put(uint8_t *p, uint64_t x, int n) {
  for (int i = 0; i < n; i++) p[i] = (uint8_t)(x >> (8 * i));
}
yk yk_leaf_store8(yk a, yk x) {
  uint8_t *p = c_at(a, 1, 1);
  c_put(p, (uint32_t)to_int32(x) & 255, 1);
  return x;
}
yk yk_leaf_store16(yk a, yk x) {
  uint8_t *p = c_at(a, 2, 1);
  c_put(p, (uint32_t)to_int32(x) & 65535, 2);
  return x;
}
yk yk_leaf_store32(yk a, yk x) {
  uint8_t *p = c_at(a, 4, 1);
  c_put(p, to_uint32(x), 4);
  return x;
}
/* A BigInt's low 64 bits (a store into a block whose address never escapes). */
uint64_t yk_big_low64(yk x) { return big_low64(want_big(x)); }
yk yk_leaf_store64(yk a, yk x) {
  uint8_t *p = c_at(a, 8, 1);
  c_put(p, big_low64(want_big(x)), 8);
  return x;
}
yk yk_leaf_store_f64(yk a, yk x) {
  uint8_t *p = c_at(a, 8, 1);
  double d = to_number(x);
  uint64_t u;
  memcpy(&u, &d, 8);
  c_put(p, u, 8);
  return x;
}
yk yk_leaf_store_f32(yk a, yk x) {
  uint8_t *p = c_at(a, 4, 1);
  float f = (float)to_number(x);
  uint32_t u;
  memcpy(&u, &f, 4);
  c_put(p, u, 4);
  return x;
}
yk yk_leaf_f32(yk x) { return yk_number((float)to_number(x)); }

/* __ykData(kind, values): the values laid out once per distinct content, read-only. */
yk yk_leaf_data(yk kind, yk values) {
  yk_array *vs = arr(values);
  /* The content's key, as the JavaScript definition makes it: kind, ":", the values joined by ",". */
  yk key = concat(str(to_string(kind)), str(ascii(":")));
  for (uint32_t i = 0; i < vs->len; i++) {
    if (i > 0) key = concat(str(key), str(ascii(",")));
    key = concat(str(key), str(to_string(vs->items[i])));
  }
  if (c_data_keys == 0) c_data_keys = yk_object_of(0, NULL, NULL);
  yk known;
  if (own_get((yk_object *)PTR(c_data_keys), key, &known)) return known;
  static const char *const kinds[10] = {"i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "f64", "f32"};
  static const int sizes[10] = {1, 1, 2, 2, 4, 4, 8, 8, 8, 4};
  int k = -1;
  for (int j = 0; j < 10; j++)
    if (key_is(kind, kinds[j])) k = j;
  if (k < 0) c_trap(concat(str(ascii("constant data of kind ")), str(to_string(kind))));
  uint64_t base = c_alloc((double)sizes[k] * vs->len, sizes[k], 1);
  uint8_t *p = c_regions[c_nregions - 1].bytes;
  for (uint32_t i = 0; i < vs->len; i++) {
    yk v = vs->items[i];
    uint8_t *q = p + (size_t)i * sizes[k];
    if (k <= 5) {
      double d = to_number(v);
      c_put(q, double_to_u32(d), sizes[k]);
    } else if (k <= 7) {
      c_put(q, big_low64(is_bigint(v) ? big(v) : big(big_from_double(to_number(v)))), 8);
    } else if (k == 8) {
      double d = to_number(v);
      uint64_t u;
      memcpy(&u, &d, 8);
      c_put(q, u, 8);
    } else {
      float f = (float)to_number(v);
      uint32_t u;
      memcpy(&u, &f, 4);
      c_put(q, u, 4);
    }
  }
  yk addr = yk_number((double)base);
  own_set((yk_object *)PTR(c_data_keys), key, addr);
  return addr;
}

/* BigInt(x): a number (an integer, else a RangeError), a string (StringToBigInt, else a
   SyntaxError), a boolean, or a BigInt. */
static yk builtin_bigint(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk v = to_primitive(argc > 0 ? argv[0] : YK_UNDEFINED);
  if (is_number(v)) return big_from_double(num(v));
  return BOX(T_BIGINT, want_bigint(v));
}
/* BigInt.asUintN(bits, x) and asIntN: x modulo 2^bits, then (asIntN) the upper half negative. */
static yk big_as_n(uint64_t argc, const yk *argv, int is_signed) {
  uint32_t bits = to_index(argc > 0 ? argv[0] : YK_UNDEFINED, "Invalid value: not (convertible to) a safe integer");
  yk_bigint *x = want_bigint(argc > 1 ? argv[1] : YK_UNDEFINED);
  if (bits == 0) return big_from_u64(0, 0);
  uint32_t n = (bits + 31) / 32;
  uint32_t m = (x->len > n ? x->len : n) + 1;
  uint32_t *w = alloc((size_t)m * 4);
  twos(x, w, m);
  if (bits % 32 != 0) w[n - 1] &= (1u << (bits % 32)) - 1;
  for (uint32_t i = n; i < m; i++) w[i] = 0;
  yk_bigint *r = big_new(n);
  memcpy(r->d, w, (size_t)n * 4);
  yk u = big_box(r);
  if (is_signed && mag_bit(big(u), bits - 1)) {
    yk_bigint *p = big(big_shl_mag(big(big_from_u64(1, 0)), 0, bits));
    return big_add_signed(big(u), 0, p, 1);
  }
  return u;
}
static yk builtin_bigint_as_uint_n(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return big_as_n(argc, argv, 0);
}
static yk builtin_bigint_as_int_n(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return big_as_n(argc, argv, 1);
}

/* The constructors of the buffers and views, and TextEncoder, as global values; 0 if none. */
/* %TypedArray%: the typed array constructors' parent, not itself constructible. */
static yk typed_array_abstract(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s, (void)argc, (void)argv;
  type_error("Abstract class TypedArray not directly constructable");
  return YK_UNDEFINED;
}
static yk typed_array_constructor(void) {
  static yk f;
  if (f != 0) return f;
  f = named(yk_closure_new(typed_array_abstract, 0, 0, NULL), ascii("TypedArray"));
  yk p = intrinsic_proto(I_TYPED_ARRAY);
  own_set(own_props(f), ascii("prototype"), p);
  own_set((yk_object *)PTR(p), ascii("constructor"), f);
  return f;
}
static yk buffer_global(const char *name, uint64_t n) {
  static yk fns[TA_COUNT + 3];
  for (int32_t k = 0; k < TA_COUNT; k++)
    if (strlen(ta_names[k]) == n && memcmp(ta_names[k], name, n) == 0) {
      if (fns[k] != 0) return fns[k];
      const char *const names[2] = {"from", "of"};
      const yk_code codes[2] = {ta_from_codes[k], ta_of_codes[k]};
      yk f = with_methods(ta_codes[k], 2, names, codes);
      yk_set(f, ascii("BYTES_PER_ELEMENT"), yk_number(ta_size[k]));
      /* Its prototype inherits %TypedArray.prototype%; it inherits %TypedArray%. */
      yk p = intrinsic_proto(I_TA_BASE + k);
      own_set(own_props(f), ascii("prototype"), p);
      own_set((yk_object *)PTR(p), ascii("constructor"), f);
      ((yk_closure *)PTR(f))->parent = typed_array_constructor();
      return fns[k] = f;
    }
  if (n == 11 && memcmp(name, "ArrayBuffer", 11) == 0) {
    if (fns[TA_COUNT] == 0) {
      static const char *const names[1] = {"isView"};
      static const yk_code codes[1] = {builtin_array_buffer_is_view};
      fns[TA_COUNT] = with_methods(builtin_array_buffer, 1, names, codes);
      yk p = intrinsic_proto(I_ARRAY_BUFFER);
      own_set(own_props(fns[TA_COUNT]), ascii("prototype"), p);
      own_set((yk_object *)PTR(p), ascii("constructor"), fns[TA_COUNT]);
    }
    return fns[TA_COUNT];
  }
  if (n == 6 && memcmp(name, "BigInt", 6) == 0) {
    static yk bigint_fn;
    if (bigint_fn == 0) {
      static const char *const names[2] = {"asUintN", "asIntN"};
      static const yk_code codes[2] = {builtin_bigint_as_uint_n, builtin_bigint_as_int_n};
      bigint_fn = with_methods(builtin_bigint, 2, names, codes);
    }
    return bigint_fn;
  }
  if (n == 8 && memcmp(name, "DataView", 8) == 0) {
    if (fns[TA_COUNT + 1] == 0) {
      fns[TA_COUNT + 1] = yk_closure_new(builtin_data_view, 0, 0, NULL);
      yk p = intrinsic_proto(I_DATA_VIEW);
      own_set(own_props(fns[TA_COUNT + 1]), ascii("prototype"), p);
      own_set((yk_object *)PTR(p), ascii("constructor"), fns[TA_COUNT + 1]);
    }
    return fns[TA_COUNT + 1];
  }
  if (n == 11 && memcmp(name, "TextEncoder", 11) == 0)
    return fns[TA_COUNT + 2] != 0 ? fns[TA_COUNT + 2] : (fns[TA_COUNT + 2] = yk_closure_new(builtin_text_encoder, 0, 0, NULL));
  return 0;
}
/* A buffer or view constructor's code: what `new` calls. */
static int is_buffer_code(yk_code code) {
  return type_of_code(code) >= 0 || code == builtin_array_buffer || code == builtin_data_view ||
         code == builtin_text_encoder;
}

/* The leaves as function values: each calls the leaf with its arguments (undefined past argc). */
#define LEAF_VALUE1(name, fn)                                                                   \
  static yk name(void *c, yk s, uint64_t argc, const yk *argv) {                                 \
    (void)c, (void)s;                                                                            \
    return fn(argc > 0 ? argv[0] : YK_UNDEFINED);                                                \
  }
#define LEAF_VALUE2(name, fn)                                                                   \
  static yk name(void *c, yk s, uint64_t argc, const yk *argv) {                                 \
    (void)c, (void)s;                                                                            \
    return fn(argc > 0 ? argv[0] : YK_UNDEFINED, argc > 1 ? argv[1] : YK_UNDEFINED);             \
  }
LEAF_VALUE2(leaf_v_i32mul, yk_leaf_i32mul)
LEAF_VALUE1(leaf_v_u64, yk_leaf_u64)
LEAF_VALUE1(leaf_v_i64, yk_leaf_i64)
LEAF_VALUE1(leaf_v_num_to_big, yk_leaf_num_to_big)
LEAF_VALUE1(leaf_v_big_to_i32, yk_leaf_big_to_i32)
LEAF_VALUE1(leaf_v_big_to_u32, yk_leaf_big_to_u32)
LEAF_VALUE1(leaf_v_big_to_f64, yk_leaf_big_to_f64)
LEAF_VALUE1(leaf_v_f64_to_i64, yk_leaf_f64_to_i64)
LEAF_VALUE1(leaf_v_f64_bits, yk_leaf_f64_bits)
LEAF_VALUE1(leaf_v_f64_from_bits, yk_leaf_f64_from_bits)
LEAF_VALUE1(leaf_v_f64_hi, yk_leaf_f64_hi)
LEAF_VALUE1(leaf_v_f64_lo, yk_leaf_f64_lo)
LEAF_VALUE2(leaf_v_f64_make, yk_leaf_f64_make)
LEAF_VALUE2(leaf_v_alloc, yk_leaf_alloc)
LEAF_VALUE1(leaf_v_fn_addr, yk_leaf_fn_addr)
LEAF_VALUE1(leaf_v_fn_at, yk_leaf_fn_at)
LEAF_VALUE1(leaf_v_free, yk_leaf_free)
LEAF_VALUE2(leaf_v_data, yk_leaf_data)
LEAF_VALUE1(leaf_v_load8, yk_leaf_load8)
LEAF_VALUE1(leaf_v_load16, yk_leaf_load16)
LEAF_VALUE1(leaf_v_load32, yk_leaf_load32)
LEAF_VALUE1(leaf_v_load64, yk_leaf_load64)
LEAF_VALUE1(leaf_v_load_f64, yk_leaf_load_f64)
LEAF_VALUE1(leaf_v_load_f32, yk_leaf_load_f32)
LEAF_VALUE2(leaf_v_store8, yk_leaf_store8)
LEAF_VALUE2(leaf_v_store16, yk_leaf_store16)
LEAF_VALUE2(leaf_v_store32, yk_leaf_store32)
LEAF_VALUE2(leaf_v_store64, yk_leaf_store64)
LEAF_VALUE2(leaf_v_store_f64, yk_leaf_store_f64)
LEAF_VALUE2(leaf_v_store_f32, yk_leaf_store_f32)
LEAF_VALUE1(leaf_v_f32, yk_leaf_f32)
#define N_LEAVES 31
static yk leaf_value(const char *name, uint64_t n) {
  static const char *names[N_LEAVES] = {"__ykI32Mul", "__ykU64", "__ykI64", "__ykNumToBig",
                                        "__ykBigToI32", "__ykBigToU32", "__ykBigToF64",
                                        "__ykF64ToI64", "__ykF64Bits", "__ykF64FromBits",
                                        "__ykF64Hi", "__ykF64Lo", "__ykF64Make",
                                        "__ykAlloc", "__ykFree", "__ykData", "__ykLoad8", "__ykLoad16",
                                        "__ykLoad32", "__ykLoad64", "__ykLoadF64", "__ykLoadF32",
                                        "__ykStore8", "__ykStore16", "__ykStore32", "__ykStore64",
                                        "__ykStoreF64", "__ykStoreF32", "__ykF32", "__ykFnAddr", "__ykFnAt"};
  static const yk_code codes[N_LEAVES] = {leaf_v_i32mul, leaf_v_u64, leaf_v_i64, leaf_v_num_to_big,
                                          leaf_v_big_to_i32, leaf_v_big_to_u32, leaf_v_big_to_f64,
                                          leaf_v_f64_to_i64, leaf_v_f64_bits, leaf_v_f64_from_bits,
                                          leaf_v_f64_hi, leaf_v_f64_lo, leaf_v_f64_make,
                                          leaf_v_alloc, leaf_v_free, leaf_v_data, leaf_v_load8, leaf_v_load16,
                                          leaf_v_load32, leaf_v_load64, leaf_v_load_f64, leaf_v_load_f32,
                                          leaf_v_store8, leaf_v_store16, leaf_v_store32, leaf_v_store64,
                                          leaf_v_store_f64, leaf_v_store_f32, leaf_v_f32, leaf_v_fn_addr, leaf_v_fn_at};
  static yk fns[N_LEAVES];
  for (int i = 0; i < N_LEAVES; i++)
    if (strlen(names[i]) == n && memcmp(names[i], name, n) == 0)
      return fns[i] != 0 ? fns[i] : (fns[i] = yk_closure_new(codes[i], 0, 0, NULL));
  return 0;
}

#define N_GLOBALS 41
static yk global_raw(const char *name, uint64_t n);
static yk global_this(void);
static yk reflect_global(void);
static yk function_global(void);
/* A global's value; a built-in constructor's `prototype` is its intrinsic prototype (#1331). */
/* --- the runtime's own internalBinding layer (V8's role for Node: node-platform's BINDINGS,
       layer "runtime"); the others come from shaved code --- */

/* internalBinding('types'): V8's value predicates, over the runtime's object model. */
static const char *const type_predicates[] = {
    "isAnyArrayBuffer", "isArgumentsObject", "isArrayBuffer", "isAsyncFunction", "isBigIntObject",
    "isBooleanObject", "isBoxedPrimitive", "isDataView", "isDate", "isExternal", "isGeneratorFunction",
    "isGeneratorObject", "isMap", "isMapIterator", "isModuleNamespaceObject", "isNativeError",
    "isNumberObject", "isPromise", "isProxy", "isRegExp", "isSet", "isSetIterator",
    "isSharedArrayBuffer", "isStringObject", "isSymbolObject", "isWeakMap", "isWeakSet", NULL};
static yk type_predicate(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  const char *which = type_predicates[(int)num(((yk_closure *)c)->captures[0])];
  yk v = arg_or_undefined(argc, argv, 0);
  int kind = is_object(v) ? ((yk_object *)PTR(v))->kind : -1;
  yk_object *o = is_object(v) ? (yk_object *)PTR(v) : NULL;
  int weak = o != NULL && (kind == 1 || kind == 2) && o->ext == &weak_marker;
  int mode = is_closure(v) ? ((yk_closure *)PTR(v))->mode : -1;
  int r = 0;
  if (!strcmp(which, "isAnyArrayBuffer") || !strcmp(which, "isArrayBuffer")) r = kind == 6;
  else if (!strcmp(which, "isAsyncFunction")) r = mode == 1 || mode == 3;
  else if (!strcmp(which, "isGeneratorFunction")) r = mode == 2 || mode == 3;
  else if (!strcmp(which, "isGeneratorObject")) r = kind == 5 || kind == 9;
  else if (!strcmp(which, "isDataView")) r = kind == 8;
  else if (!strcmp(which, "isDate")) r = kind == 10;
  else if (!strcmp(which, "isMap")) r = kind == 1 && !weak;
  else if (!strcmp(which, "isSet")) r = kind == 2 && !weak;
  else if (!strcmp(which, "isWeakMap")) r = kind == 1 && weak;
  else if (!strcmp(which, "isWeakSet")) r = kind == 2 && weak;
  else if (!strcmp(which, "isMapIterator")) r = kind == 13 && ((builtin_iter *)o->ext)->type == 2;
  else if (!strcmp(which, "isSetIterator")) r = kind == 13 && ((builtin_iter *)o->ext)->type == 3;
  else if (!strcmp(which, "isNativeError")) r = o != NULL && o->error;
  else if (!strcmp(which, "isPromise")) r = kind == 4;
  else if (!strcmp(which, "isRegExp")) r = kind == 3;
  /* No arguments objects, primitive wrappers, externals, proxies or shared memory in the runtime. */
  return yk_bool(r);
}
/* internalBinding('util')'s members that are V8's object model (the rest are node_util.cc's, shaved). */
static int canonical_index(yk_string *s, uint32_t *out);
static yk util_get_own_non_index_properties(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk v = arg_or_undefined(argc, argv, 0);
  int filter = (int)to_number(arg_or_undefined(argc, argv, 1));
  yk_array *r = new_array(4);
  yk_object *o = NULL;
  /* The non-enumerable own ones, when all are asked for: an array's length, a function's name,
     length and prototype. */
  if (!(filter & 2) && !(filter & 8)) {
    if (is_array(v)) push(r, ascii("length"));
    if (is_closure(v)) {
      push(r, ascii("length"));
      push(r, ascii("name"));
      yk_closure *c = (yk_closure *)PTR(v);
      if (c->has_this || c->is_class) push(r, ascii("prototype"));
    }
  }
  if (is_array(v)) o = arr(v)->props != 0 ? (yk_object *)PTR(arr(v)->props) : NULL;
  else if (is_object(v)) o = (yk_object *)PTR(v);
  else if (is_closure(v) && ((yk_closure *)PTR(v))->props != 0) o = (yk_object *)PTR(((yk_closure *)PTR(v))->props);
  if (o == NULL) return BOX(T_ARRAY, r);
  /* V8's PropertyFilter: 8 skips strings, 16 symbols; enumerability is not tracked (all are). */
  if (!(filter & 8)) {
    /* 2 (ONLY_ENUMERABLE): the enumerable ones. */
    yk_array *keys = (filter & 2) ? enumerable_keys(o) : ordered_keys(o);
    for (uint32_t i = 0; i < keys->len; i++) {
      uint32_t k;
      yk key = keys->items[i];
      if (canonical_index(str(key), &k)) continue;
      if (is_closure(v) && (key_is(key, "prototype") || key_is(key, "name") || key_is(key, "length"))) continue;
      push(r, key);
    }
  }
  if (!(filter & 16)) {
    yk_array *syms = symbol_keys(o);
    for (uint32_t i = 0; i < syms->len; i++) push(r, syms->items[i]);
  }
  return BOX(T_ARRAY, r);
}
static yk util_get_promise_details(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk p = arg_or_undefined(argc, argv, 0);
  if (!is_promise(p)) return YK_UNDEFINED;
  promise_state *st = (promise_state *)((yk_object *)PTR(p))->ext;
  yk items[2] = {yk_number(st->state), st->value};
  return yk_array_of(st->state == 0 ? 1 : 2, items);
}
static yk util_get_proxy_details(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self, (void)argc, (void)argv;
  return YK_UNDEFINED; /* no proxies in the runtime */
}
/* previewEntries(value, isIterator): a Map's, Set's, weak collection's or their iterator's entries
   (flattened [k, v, …] for a Map's), with whether they are pairs when asked. */
static yk util_preview_entries(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk v = arg_or_undefined(argc, argv, 0);
  int pairs_wanted = argc > 1 && yk_truthy(argv[1]);
  if (!is_object(v)) return YK_UNDEFINED;
  yk_object *o = (yk_object *)PTR(v);
  yk_array *r = new_array(4);
  int is_pairs = 0;
  if (o->kind == 1 || o->kind == 2) {
    is_pairs = o->kind == 1;
    for (uint32_t j = 0; j < o->entries->len; j++) {
      yk e = o->entries->items[j];
      if (o->kind == 1) push(r, arr(e)->items[0]), push(r, arr(e)->items[1]);
      else push(r, e);
    }
  } else if (o->kind == 13) {
    builtin_iter *b = o->ext;
    if (b->src != 0 && b->type >= 2) {
      yk_array *es = ((yk_object *)PTR(b->src))->entries;
      is_pairs = b->type == 2 && b->mode == 2;
      for (uint32_t j = b->i; j < es->len; j++) {
        yk e = es->items[j];
        if (b->type == 3) push(r, e);
        else if (b->mode == 2) push(r, arr(e)->items[0]), push(r, arr(e)->items[1]);
        else push(r, arr(e)->items[b->mode == 0 ? 0 : 1]);
      }
    }
  } else
    return YK_UNDEFINED;
  if (!pairs_wanted) return BOX(T_ARRAY, r);
  yk items[2] = {BOX(T_ARRAY, r), yk_bool(is_pairs)};
  return yk_array_of(2, items);
}
/* V8's GetConstructorName: the name of the constructor along the value's chain, else "Object". */
static yk util_get_constructor_name(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  yk v = arg_or_undefined(argc, argv, 0);
  for (yk p = v; is_object(p) || is_closure(p) || is_array(p); p = prototype_of(p)) {
    yk ctor;
    if (has_own(p, ascii("constructor")) && is_closure(ctor = yk_get(p, ascii("constructor")))) {
      yk name = yk_get(ctor, ascii("name"));
      if (is_string(name) && str(name)->len > 0) return name;
    }
  }
  return ascii("Object");
}
static yk util_get_external_value(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self, (void)argc, (void)argv;
  return big_from_i64(0);
}
static yk builtin_runtime_binding(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)c, (void)self;
  static yk types, util;
  yk name = arg_or_undefined(argc, argv, 0);
  if (is_string(name) && key_is(name, "util")) {
    if (util != 0) return util;
    static const char *const m[6] = {"getOwnNonIndexProperties", "getPromiseDetails", "getProxyDetails",
                                     "previewEntries", "getConstructorName", "getExternalValue"};
    static const yk_code k[6] = {util_get_own_non_index_properties, util_get_promise_details, util_get_proxy_details,
                                 util_preview_entries, util_get_constructor_name, util_get_external_value};
    util = with_methods(NULL, 6, m, k);
    /* node_util.cc's constants: V8's PropertyFilter and Promise states. */
    static const char *const cn[9] = {"kPending", "kFulfilled", "kRejected", "ALL_PROPERTIES", "ONLY_WRITABLE",
                                      "ONLY_ENUMERABLE", "ONLY_CONFIGURABLE", "SKIP_STRINGS", "SKIP_SYMBOLS"};
    static const int cv[9] = {0, 1, 2, 0, 1, 2, 4, 8, 16};
    yk consts = yk_object_of(0, NULL, NULL);
    for (int i = 0; i < 9; i++) own_set((yk_object *)PTR(consts), ascii(cn[i]), yk_number(cv[i]));
    own_set((yk_object *)PTR(util), ascii("constants"), consts);
    return util;
  }
  if (is_string(name) && key_is(name, "types")) {
    if (types != 0) return types;
    types = yk_object_of(0, NULL, NULL);
    for (int i = 0; type_predicates[i] != NULL; i++) {
      yk cap = yk_number(i), key = ascii(type_predicates[i]);
      own_set((yk_object *)PTR(types), key, named(yk_closure_new(type_predicate, 0, 1, &cap), key));
    }
    return types;
  }
  return YK_UNDEFINED;
}
/* String's statics: fromCharCode, fromCodePoint, raw. */
static yk string_from_char_code(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_string *r = new_string((uint32_t)argc);
  for (uint64_t i = 0; i < argc; i++) r->units[i] = (uint16_t)to_uint32(argv[i]);
  return string_of(r);
}
static yk string_from_code_point(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk_string *r = new_string((uint32_t)argc * 2);
  uint32_t n = 0;
  for (uint64_t i = 0; i < argc; i++) {
    double d = to_number(argv[i]);
    if (!(d >= 0 && d <= 0x10FFFF && d == floor(d))) {
      yk m = concat(str(ascii("Invalid code point ")), str(to_string(argv[i])));
      yk_throw(make_error("RangeError", m));
    }
    uint32_t cp = (uint32_t)d;
    if (cp > 0xFFFF) cp -= 0x10000, r->units[n++] = (uint16_t)(0xD800 + (cp >> 10)), r->units[n++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
    else r->units[n++] = (uint16_t)cp;
  }
  r->len = n;
  return string_of(r);
}
static yk string_raw(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk raw = yk_get(arg_or_undefined(argc, argv, 0), ascii("raw"));
  double len = to_number(yk_get(raw, ascii("length")));
  yk out = ascii("");
  for (double i = 0; i < len; i++) {
    out = concat(str(out), str(to_string(yk_get(raw, to_string(yk_number(i))))));
    if (i + 1 < len && (uint64_t)i + 1 < argc) out = concat(str(out), str(to_string(argv[(uint64_t)i + 1])));
  }
  return out;
}
/* Error.captureStackTrace(object): its stack, the header V8 gives (no frames: the runtime keeps none). */
static yk error_capture_stack_trace(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  yk o = arg_or_undefined(argc, argv, 0);
  if (!is_object(o) && !is_closure(o)) type_error("Invalid argument");
  yk name = yk_get(o, ascii("name")), message = yk_get(o, ascii("message"));
  yk n = name == YK_UNDEFINED ? ascii("Error") : to_string(name);
  yk m = message == YK_UNDEFINED ? ascii("") : to_string(message);
  yk header = str(m)->len == 0 ? n : str(n)->len == 0 ? m : concat(str(concat(str(n), str(ascii(": ")))), str(m));
  yk_set(o, ascii("stack"), header);
  return YK_UNDEFINED;
}
/* Globals a program defines for the runtime (__yakccDefineGlobal): Math as the boot module makes it. */
static yk defined_globals;
static yk global_this(void);
/* __yakccDefineGlobal(name, value, lazy): a global the boot defines; lazy, value is a function the
   first read calls, its result the global's value from then on (Node's lazily loaded globals, such
   as Buffer). */
static yk lazy_globals = 0;
static yk builtin_define_global(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  if (defined_globals == 0) defined_globals = yk_object_of(0, NULL, NULL);
  yk name = to_string(arg_or_undefined(argc, argv, 0)), value = arg_or_undefined(argc, argv, 1);
  if (argc > 2 && yk_truthy(argv[2])) {
    if (lazy_globals == 0) lazy_globals = yk_object_of(0, NULL, NULL);
    own_set((yk_object *)PTR(lazy_globals), name, value);
    own_set((yk_object *)PTR(defined_globals), name, value);
    return YK_UNDEFINED;
  }
  if (lazy_globals != 0) yk_delete(lazy_globals, name);
  own_set((yk_object *)PTR(defined_globals), name, value);
  own_set((yk_object *)PTR(global_this()), name, value);
  return value;
}
/* A defined global's value: a lazy one's made now, once. */
static yk defined_value(yk name, yk v) {
  yk f;
  if (lazy_globals == 0 || !own_get((yk_object *)PTR(lazy_globals), name, &f)) return v;
  yk_delete(lazy_globals, name);
  yk made = call_value(f, YK_UNDEFINED, 0, NULL);
  own_set((yk_object *)PTR(defined_globals), name, made);
  own_set((yk_object *)PTR(global_this()), name, made);
  return made;
}
/* Array.of(...items). */
static yk builtin_array_of(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  return yk_array_of(argc, argv);
}
static yk global_uncached(const char *name, uint64_t n);
static yk builtin_set_builtin_require(void *c, yk s, uint64_t argc, const yk *argv);
/* A global's value: a defined global's (__yakccDefineGlobal) as it is now; anything else (the
   runtime's own, fixed once made) from a cache by name, so a read in a loop makes nothing again. */
static yk global_cache = 0;
yk yk_global(const char *name, uint64_t n) {
  if (defined_globals != 0) {
    yk v, key = interned(name, n);
    if (own_get((yk_object *)PTR(defined_globals), key, &v)) return defined_value(key, v);
  }
  if (global_cache == 0) global_cache = yk_object_of(0, NULL, NULL);
  yk key = interned(name, n), v;
  if (own_get((yk_object *)PTR(global_cache), key, &v)) return v;
  v = global_uncached(name, n);
  own_set((yk_object *)PTR(global_cache), key, v);
  return v;
}
static yk global_uncached(const char *name, uint64_t n) {
  if (defined_globals != 0) {
    yk v;
    if (own_get((yk_object *)PTR(defined_globals), interned(name, n), &v)) return v;
  }
  if (n == 19 && memcmp(name, "__yakccDefineGlobal", 19) == 0) {
    static yk f;
    return f != 0 ? f : (f = yk_closure_new(builtin_define_global, 0, 0, NULL));
  }
  if (n == 24 && memcmp(name, "__yakccSetBuiltinRequire", 24) == 0) {
    static yk f;
    return f != 0 ? f : (f = yk_closure_new(builtin_set_builtin_require, 0, 0, NULL));
  }
  if (n == 10 && memcmp(name, "globalThis", 10) == 0) return global_this();
  if (n == 7 && memcmp(name, "Reflect", 7) == 0) return reflect_global();
  if (n == 8 && memcmp(name, "Function", 8) == 0) return function_global();
  yk v = global_raw(name, n);
  if (!is_closure(v)) return v;
  if (((yk_closure *)PTR(v))->fname == 0) {
    named(v, yk_string_utf8(name, n));
    if (n == 6 && memcmp(name, "String", 6) == 0) {
      static const char *const m[3] = {"fromCharCode", "fromCodePoint", "raw"};
      static const yk_code k[3] = {string_from_char_code, string_from_code_point, string_raw};
      for (int i = 0; i < 3; i++) own_set(own_props(v), ascii(m[i]), named(yk_closure_new(k[i], 0, 0, NULL), ascii(m[i])));
    }
    if (n == 5 && memcmp(name, "Error", 5) == 0) {
      own_set(own_props(v), ascii("captureStackTrace"), named(yk_closure_new(error_capture_stack_trace, 0, 0, NULL), ascii("captureStackTrace")));
      own_set(own_props(v), ascii("stackTraceLimit"), yk_number(10));
    }
  }
  static const char *const ctors[] = {"Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
                                      "Map", "Set", "Promise", "Error", "TypeError", "RangeError", "SyntaxError",
                                      "EvalError", "ReferenceError", "URIError", "AggregateError", "WeakMap",
                                      "WeakSet", "WeakRef", "FinalizationRegistry", "Date", "RegExp"};
  static const int which[] = {I_OBJECT, I_ARRAY, I_STRING, I_NUMBER, I_BOOLEAN, I_SYMBOL, I_BIGINT,
                              I_MAP, I_SET, I_PROMISE, I_ERROR, I_ERROR, I_ERROR, I_ERROR,
                              I_ERROR, I_ERROR, I_ERROR, I_ERROR, I_WEAKMAP,
                              I_WEAKSET, I_WEAKREF, I_FINREG, I_DATE, I_REGEXP};
  for (int i = 0; i < 24; i++)
    if (strlen(ctors[i]) == n && memcmp(ctors[i], name, n) == 0 && !has_own(v, ascii("prototype"))) {
      yk p = intrinsic_proto(which[i]);
      own_set(own_props(v), ascii("prototype"), p);
      if (which[i] != I_ERROR || i == 10) own_set((yk_object *)PTR(p), ascii("constructor"), v);
      if (which[i] == I_WEAKMAP || which[i] == I_WEAKSET) /* not Map's nor Set's */
        ((yk_object *)PTR(p))->proto = intrinsic_proto(I_OBJECT);
    }
  return v;
}
static yk global_raw(const char *name, uint64_t n) {
  if (n > 4 && memcmp(name, "__yk", 4) == 0) {
    yk leaf = leaf_value(name, n);
    if (leaf != 0) return leaf;
  }
  {
    yk b = buffer_global(name, n);
    if (b != 0) return b;
  }
  if (n == 7 && memcmp(name, "process", 7) == 0) return process_global();
  if (n == 21 && memcmp(name, "__yakccRuntimeBinding", 21) == 0) {
    static yk f;
    return f != 0 ? f : (f = named(yk_closure_new(builtin_runtime_binding, 0, 0, NULL), ascii("internalBinding")));
  }
  if (n == 7 && memcmp(name, "console", 7) == 0) return console_global();
  if (n == 3 && memcmp(name, "NaN", 3) == 0) return yk_number(NAN);
  if (n == 8 && memcmp(name, "Infinity", 8) == 0) return yk_number(INFINITY);
  static yk fns[N_GLOBALS];
  static const char *names[N_GLOBALS] = {"String", "Number", "Boolean", "parseFloat", "parseInt",
                                         "isNaN", "isFinite", "Array", "globalThis", "__yakccTry",
                                         "Error", "TypeError", "RangeError", "SyntaxError",
                                         "Map", "Set", "Object", "JSON", "Symbol", "Promise",
                                         "__yakccTryAsync", "queueMicrotask", "__yakccTryGen",
                                         "__yakccTryAsyncGen", "encodeURIComponent", "encodeURI",
                                         "decodeURIComponent", "decodeURI", "escape", "unescape", "eval",
                                         "EvalError", "ReferenceError", "URIError", "AggregateError",
                                         "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Date",
                                         "RegExp"};
  static yk_code codes[N_GLOBALS] = {builtin_string, builtin_number, builtin_boolean,
                                     builtin_parse_float, builtin_parse_int, builtin_is_nan,
                                     builtin_is_finite, builtin_array, NULL, builtin_try,
                                     builtin_error, builtin_type_error, builtin_range_error,
                                     builtin_syntax_error, builtin_map, builtin_set, builtin_object,
                                     NULL, NULL, builtin_promise, try_async_body,
                                     builtin_queue_microtask, try_gen_code, try_async_gen_code,
                                     builtin_encode_uri_component, builtin_encode_uri,
                                     builtin_decode_uri_component, builtin_decode_uri, builtin_escape,
                                     builtin_unescape, builtin_eval, builtin_eval_error,
                                     builtin_reference_error, builtin_uri_error, builtin_aggregate_error,
                                     builtin_weak_map, builtin_weak_set, builtin_weak_ref,
                                     builtin_finalization_registry, builtin_date, builtin_regexp};
  for (int i = 0; i < N_GLOBALS; i++)
    if (strlen(names[i]) == n && memcmp(names[i], name, n) == 0) {
      if (fns[i] != 0) return fns[i];
      if (strcmp(names[i], "JSON") == 0) {
        static const char *const m[2] = {"stringify", "parse"};
        static const yk_code k[2] = {builtin_json_stringify, builtin_json_parse};
        return fns[i] = with_methods(NULL, 2, m, k);
      }
      if (strcmp(names[i], "Symbol") == 0) return fns[i] = symbol_global();
      if (codes[i] == NULL) return YK_UNDEFINED;
      if (codes[i] == builtin_promise) {
        static const char *const m[5] = {"resolve", "reject", "all", "allSettled", "race"};
        static const yk_code k[5] = {promise_static_resolve, promise_static_reject, promise_static_all,
                                     promise_static_all_settled, promise_static_race};
        return fns[i] = with_methods(builtin_promise, 5, m, k);
      }
      if (codes[i] == try_async_body) return fns[i] = yk_closure_mode(yk_closure_new(try_async_body, 0, 0, NULL), 1);
      if (codes[i] == try_gen_code) return fns[i] = yk_closure_mode(yk_closure_new(try_gen_code, 0, 0, NULL), 2);
      if (codes[i] == try_async_gen_code)
        return fns[i] = yk_closure_mode(yk_closure_new(try_async_gen_code, 0, 0, NULL), 3);
      if (codes[i] == builtin_date) {
        static const char *const m[3] = {"now", "parse", "UTC"};
        static const yk_code k[3] = {date_static_now, date_static_parse, date_static_utc};
        return fns[i] = with_methods(builtin_date, 3, m, k);
      }
      if (codes[i] == builtin_array) {
        static const char *const m[3] = {"from", "isArray", "of"};
        static const yk_code k[3] = {builtin_array_from, builtin_array_is_array, builtin_array_of};
        return fns[i] = with_methods(builtin_array, 3, m, k);
      }
      if (codes[i] == builtin_number) {
        static const char *const m[6] = {"isFinite", "isInteger", "isSafeInteger", "isNaN", "parseFloat", "parseInt"};
        static const yk_code k[6] = {builtin_number_is_finite, builtin_number_is_integer,
                                     builtin_number_is_safe_integer, builtin_number_is_nan,
                                     builtin_parse_float, builtin_parse_int};
        yk f = with_methods(builtin_number, 6, m, k);
        static const char *const cn[8] = {"MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "EPSILON", "MAX_VALUE",
                                          "MIN_VALUE", "POSITIVE_INFINITY", "NEGATIVE_INFINITY", "NaN"};
        const double cv[8] = {9007199254740991.0, -9007199254740991.0, 2.220446049250313e-16, 1.7976931348623157e308,
                              5e-324, INFINITY, -INFINITY, NAN};
        for (int j = 0; j < 8; j++) yk_set(f, ascii(cn[j]), yk_number(cv[j]));
        return fns[i] = f;
      }
      if (codes[i] == builtin_object) {
        static const char *const m[23] = {"keys", "values", "entries", "assign", "freeze", "is",
                                          "getPrototypeOf", "setPrototypeOf", "getOwnPropertyNames",
                                          "getOwnPropertySymbols", "getOwnPropertyDescriptor",
                                          "getOwnPropertyDescriptors", "defineProperty", "defineProperties",
                                          "create", "hasOwn", "fromEntries", "isFrozen", "isSealed",
                                          "isExtensible", "preventExtensions", "seal", "groupBy"};
        static const yk_code k[23] = {builtin_object_keys, builtin_object_values, builtin_object_entries,
                                      builtin_object_assign, builtin_identity, builtin_object_is,
                                      reflect_get_prototype_of, reflect_set_prototype_of,
                                      object_get_own_property_names, object_get_own_property_symbols,
                                      reflect_get_own_property_descriptor, object_get_own_property_descriptors,
                                      object_define_property, object_define_properties, object_create,
                                      object_has_own, object_from_entries, object_false, object_false,
                                      object_true, object_first, object_first, object_false};
        return fns[i] = with_methods(builtin_object, 23, m, k);
      }
      return fns[i] = yk_closure_new(codes[i], 0, 0, NULL);
    }
  return YK_UNDEFINED;
}

/* new F(…): the constructors the runtime has (Array). */
yk yk_new(yk f, uint64_t argc, const yk *argv) {
  if (is_closure(f)) {
    yk_code code = ((yk_closure *)PTR(f))->code;
    if (code == builtin_promise) return promise_construct(argc, argv);
    if (((yk_closure *)PTR(f))->mode != 0) type_error("this function is not a constructor");
    if (is_buffer_code(code)) return code(NULL, YK_UNDEFINED, argc, argv);
    if (code == builtin_array || code == builtin_error || code == builtin_type_error ||
        code == builtin_range_error || code == builtin_syntax_error || code == builtin_map ||
        code == builtin_set || code == builtin_object || code == builtin_eval_error ||
        code == builtin_reference_error || code == builtin_uri_error || code == builtin_aggregate_error ||
        code == builtin_weak_map || code == builtin_weak_set || code == builtin_weak_ref ||
        code == builtin_finalization_registry || code == builtin_regexp)
      return code(NULL, YK_UNDEFINED, argc, argv);
    if (code == builtin_date) return date_construct(argc, argv);
    /* A class, or a `function`: an object inheriting its prototype, given to it as `this`. */
    yk_closure *c = (yk_closure *)PTR(f);
    if (c->is_class || c->has_this) {
      yk o = yk_object_of(0, NULL, NULL);
      ((yk_object *)PTR(o))->proto = ensure_prototype(f);
      /* A base class's fields are the instance's before its constructor's body runs (#1330). */
      if (c->is_class && c->parent == 0) init_fields(f, o);
      yk r = c->code(c, o, argc, argv);
      return is_reference(r) ? r : o;
    }
  }
  type_error("this constructor is not in the runtime yet");
  return YK_UNDEFINED;
}

/* The built-in constructors whose instances are objects with internal state a subclass's receiver
   can take over (class SafeMap extends Map). */
static int is_adoptable_builtin(yk f) {
  if (!is_closure(f)) return 0;
  yk_code code = ((yk_closure *)PTR(f))->code;
  return code == builtin_map || code == builtin_set || code == builtin_weak_map || code == builtin_weak_set ||
         code == builtin_weak_ref || code == builtin_finalization_registry || code == builtin_promise ||
         code == builtin_date || code == builtin_regexp || is_buffer_code(code);
}
/* a instanceof F, for the constructors the runtime has: Array, and the Error family. */
yk yk_instanceof(yk v, yk f) {
  if (!is_closure(f)) type_error("Right-hand side of 'instanceof' is not callable");
  yk_code code = ((yk_closure *)PTR(f))->code;
  if (code == builtin_array) return yk_bool(is_array(v));
  if (type_of_code(code) >= 0) return yk_bool(typed_of(v) != NULL && typed_of(v)->type == type_of_code(code));
  if (code == builtin_array_buffer) return yk_bool(buffer_of(v) != NULL);
  if (code == builtin_data_view) return yk_bool(dataview_of(v) != NULL);
  if (code == builtin_promise) return yk_bool(is_promise(v));
  if (code == builtin_error || code == builtin_type_error || code == builtin_range_error ||
      code == builtin_syntax_error) {
    if (!is_object(v) || !((yk_object *)PTR(v))->error) return YK_FALSE;
    if (code == builtin_error) return YK_TRUE;
    yk name;
    own_get((yk_object *)PTR(v), ascii("name"), &name);
    const char *want = code == builtin_type_error ? "TypeError" : code == builtin_range_error ? "RangeError" : "SyntaxError";
    return yk_bool(strict_equal(name, ascii(want)));
  }
  yk_closure *c = (yk_closure *)PTR(f);
  if (c->is_class || c->has_this || is_adoptable_builtin(f)) {
    yk proto = ensure_prototype(f);
    if (!is_object(v) && !is_closure(v)) return YK_FALSE;
    for (yk o = prototype_of(v); is_object(o); o = prototype_of(o))
      if (o == proto) return YK_TRUE;
  }
  return YK_FALSE;
}

/* --- spread: a list's items, each spread one expanded (…xs) --- */

yk yk_spread_list(uint64_t n, const yk *items, const yk *spread) {
  yk_array *r = new_array((uint32_t)n);
  for (uint64_t i = 0; i < n; i++) {
    if (spread[i] != YK_TRUE) {
      push(r, items[i]);
      continue;
    }
    if (is_nullish(items[i])) type_error("the spread value is not iterable");
    yk_array *more = iterable_items(items[i]);
    for (uint32_t j = 0; j < more->len; j++) push(r, more->items[j]);
  }
  return BOX(T_ARRAY, r);
}
yk yk_call_spread(yk f, yk self, yk args) { return call_value(f, self, arr(args)->len, arr(args)->items); }
yk yk_call_method_spread(yk recv, const char *name, uint64_t n, yk args) {
  return yk_call_method(recv, name, n, arr(args)->len, arr(args)->items);
}
/* Math.random: xorshift128+ (as V8's), seeded from the clock and the process, 53 bits in [0, 1). */
yk yk_math_random(void) {
  static uint64_t s0 = 0, s1 = 0;
  if (s0 == 0 && s1 == 0) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    s0 = ((uint64_t)ts.tv_sec * 1000000007u) ^ (uint64_t)ts.tv_nsec ^ ((uint64_t)getpid() << 32);
    s1 = s0 * 0x9E3779B97F4A7C15ull + 1;
    if (s0 == 0) s0 = 1;
  }
  uint64_t x = s0, y = s1;
  s0 = y;
  x ^= x << 23;
  x ^= x >> 17;
  x ^= y ^ (y >> 26);
  s1 = x;
  return yk_number((double)((s0 + s1) >> 11) / 9007199254740992.0);
}
yk yk_new_spread(yk f, yk args) { return yk_new(f, arr(args)->len, arr(args)->items); }
yk yk_super_construct_spread(void *closure, yk self, yk args) {
  return yk_super_construct(closure, self, arr(args)->len, arr(args)->items);
}

/* {…src}: src's own enumerable properties, copied in order (a getter's value, not the getter). */
yk yk_spread_into(yk obj, yk src) {
  if (is_nullish(src) || is_number(src) || is_bool(src)) return obj;
  yk_object *o = (yk_object *)PTR(obj);
  if (is_array(src) || is_string(src)) {
    uint32_t n = is_array(src) ? arr(src)->len : str(src)->len;
    for (uint32_t i = 0; i < n; i++) own_set(o, to_string(yk_number(i)), yk_get(src, yk_number(i)));
    return obj;
  }
  if (is_closure(src) && ((yk_closure *)PTR(src))->props == 0) return obj;
  yk_object *from = own_props(src);
  if (from->kind != 0) return obj;
  yk_array *keys = enumerable_keys(from);
  for (uint32_t i = 0; i < keys->len; i++) {
    yk slot;
    own_get(from, keys->items[i], &slot);
    own_set(o, keys->items[i], resolve_slot(slot, src));
  }
  /* CopyDataProperties copies the symbol-keyed ones too, after the strings. */
  keys = symbol_keys(from);
  for (uint32_t i = 0; i < keys->len; i++) {
    yk slot;
    own_get(from, keys->items[i], &slot);
    own_set(o, keys->items[i], resolve_slot(slot, src));
  }
  return obj;
}

/* {a, b, ...rest} = src: rest is src's own enumerable properties but the keys taken (CopyDataProperties
   with excluded names); src null or undefined is a TypeError, as destructuring it is. */
yk yk_object_rest(yk src, uint64_t n, const yk *taken) {
  if (is_nullish(src)) type_error("Cannot destructure 'undefined' or 'null'.");
  yk obj = yk_object_of(0, NULL, NULL);
  yk_spread_into(obj, src);
  for (uint64_t i = 0; i < n; i++) yk_delete(obj, taken[i]);
  return obj;
}

/* key in obj: an object's own property, an array's index or length. */
yk yk_in(yk key, yk obj) {
  if (is_object(obj)) {
    /* Its own properties, then its prototype's (HasProperty follows the chain). */
    yk v, k = to_property_key(key);
    for (yk o = obj; is_object(o); o = ((yk_object *)PTR(o))->proto)
      if (own_get((yk_object *)PTR(o), k, &v)) return YK_TRUE;
    /* A chain that ends with no prototype of its own goes on into its kind's intrinsic one. */
    yk t = tail_proto(obj);
    return yk_bool(t != 0 && chain_get(t, k, &v));
  }
  if (is_array(obj)) {
    if (is_symbol(key)) {
      /* Its own symbol keys, then Array.prototype's. */
      yk v;
      if (arr(obj)->props != 0 && own_get((yk_object *)PTR(arr(obj)->props), key, &v)) return YK_TRUE;
      return yk_bool(chain_get(intrinsic_proto(I_ARRAY), key, &v));
    }
    if (key_is(to_string(key), "length")) return YK_TRUE;
    int64_t i = index_of_key(key);
    return yk_bool(i >= 0 && i < arr(obj)->len && !array_hole(arr(obj), (uint32_t)i));
  }
  if (is_closure(obj)) {
    yk v, k = to_property_key(key);
    if (has_own(obj, k)) return YK_TRUE;
    return yk_bool(chain_get(obj, k, &v) || chain_get(prototype_of(obj), k, &v));
  }
  type_error("Cannot use 'in' operator to search for a key in a primitive");
  return YK_FALSE;
}

/* Whether a value is the string given in UTF-8 (a require's specifier). */
int yk_string_is(yk v, const char *p, uint64_t n) {
  return is_string(v) && string_equal(str(v), str(yk_string_utf8(p, n)));
}

void yk_fail(const char *message) {
  fprintf(stderr, "%s\n", message);
  exit(70);
}
/* The require of a module none of the program's own modules is (#1361 P2): a boot program over
   Node's library sets it (__yakccSetBuiltinRequire) to its realm's loader of the modules users may
   require; without it, or when it gives nothing, Node's MODULE_NOT_FOUND. */
static yk builtin_require_hook = 0;
static yk builtin_set_builtin_require(void *c, yk s, uint64_t argc, const yk *argv) {
  (void)c, (void)s;
  builtin_require_hook = arg_or_undefined(argc, argv, 0);
  return YK_UNDEFINED;
}
_Noreturn void yk_module_not_found(yk spec, const char *from, uint64_t n);
yk yk_require_unresolved(yk spec, const char *from, uint64_t n) {
  if (is_closure(builtin_require_hook) && is_string(spec)) {
    yk got = call_value(builtin_require_hook, YK_UNDEFINED, 1, &spec);
    if (got != YK_UNDEFINED) return got;
  }
  yk_module_not_found(spec, from, n);
}
/* require of a module the program does not have (#1370): Node's error, which a try catches (an
   optional dependency), its code MODULE_NOT_FOUND. */
_Noreturn void yk_module_not_found(yk spec, const char *from, uint64_t n) {
  yk message = concat(str(ascii("Cannot find module '")), str(to_string(spec)));
  message = concat(str(message), str(ascii("' (required from ")));
  message = concat(str(message), str(yk_string_utf8(from, n)));
  message = concat(str(message), str(ascii(")")));
  yk e = make_error("Error", message);
  yk_set(e, ascii("code"), ascii("MODULE_NOT_FOUND"));
  yk_throw(e);
}

/* A finite double's exact decimal digits (no leading zeros; "0" for zero) and how many of them are
   before the point (which may be negative or past the digits): x = mantissa * 2^e, and for e < 0
   mantissa * 5^-e scaled by 10^e. */
static char *exact_digits(double x, int *point) {
  int e;
  double m = frexp(x, &e); /* x = m * 2^e, 0.5 <= m < 1 */
  uint64_t mant = (uint64_t)ldexp(m, 53);
  e -= 53;
  /* The number, base 10^9, least significant limb first. */
  size_t cap = 140, n = 1;
  uint32_t *v = alloc(cap * sizeof(uint32_t));
  v[0] = (uint32_t)(mant % 1000000000u);
  if (mant >= 1000000000u) {
    v[n++] = (uint32_t)(mant / 1000000000u % 1000000000u);
    if (mant >= 1000000000000000000ull) v[n++] = (uint32_t)(mant / 1000000000000000000ull);
  }
  int shift = e >= 0 ? e : -e;
  uint32_t by = e >= 0 ? 2 : 5;
  for (int i = 0; i < shift; i++) {
    uint64_t carry = 0;
    for (size_t j = 0; j < n; j++) {
      uint64_t t = (uint64_t)v[j] * by + carry;
      v[j] = (uint32_t)(t % 1000000000u);
      carry = t / 1000000000u;
    }
    if (carry != 0) v[n++] = (uint32_t)carry;
  }
  char *d = alloc(n * 9 + 2);
  int len = snprintf(d, 12, "%u", v[n - 1]);
  for (size_t j = n - 1; j-- > 0;) len += snprintf(d + len, 12, "%09u", v[j]);
  int lead = 0;
  while (lead < len - 1 && d[lead] == '0') lead++;
  *point = (len - lead) - (e >= 0 ? 0 : -e);
  return d + lead;
}
/* digits[0..keep) rounded at digits[keep] as Number's formatting does (a tie to the larger): the
   kept digits in out, and 1 when the rounding carried into a new leading digit. */
static int round_digits(const char *digits, int len, int keep, char *out) {
  for (int i = 0; i < keep; i++) out[i] = i < len ? digits[i] : '0';
  out[keep] = 0;
  if (keep < 0 || keep >= len || digits[keep] < '5') return 0;
  for (int i = keep - 1; i >= 0; i--) {
    if (out[i] != '9') {
      out[i]++;
      return 0;
    }
    out[i] = '0';
  }
  memmove(out + 1, out, (size_t)keep + 1);
  out[0] = '1';
  return 1;
}
/* Number.prototype.toFixed (0), toPrecision (1) and toExponential (2), ECMA-262 21.1.3. */
static yk number_format(double x, int which, yk arg) {
  static const char *const names[3] = {"toFixed() digits argument", "toPrecision() argument", "toExponential() argument"};
  double f = arg == YK_UNDEFINED ? (which == 1 ? NAN : 0) : trunc(to_number(arg));
  if (f != f && !(which == 1 && arg == YK_UNDEFINED)) f = 0;
  if (which == 1 && arg == YK_UNDEFINED) return to_string(yk_number(x));
  if (!isfinite(x)) return to_string(yk_number(x));
  int lo = which == 1 ? 1 : 0;
  if (!(f >= lo && f <= 100)) {
    char msg[96];
    snprintf(msg, sizeof msg, "%s must be between %d and 100", names[which], lo);
    range_error(msg);
  }
  int digits_n = (int)f;
  if (which == 0 && fabs(x) >= 1e21) return to_string(yk_number(x));
  int neg = x < 0;
  double a = fabs(x);
  int point = 1;
  const char *d = a == 0 ? "0" : exact_digits(a, &point);
  int len = (int)strlen(d);
  char *buf = alloc((size_t)len + 260), *r = alloc((size_t)len + 260);
  int o = 0;
  if (neg) buf[o++] = '-';
  if (which == 0) {
    /* n / 10^f nearest x: the digits through f places after the point. */
    int keep = point + digits_n;
    if (a == 0 || keep <= 0) {
      int up = a != 0 && keep == 0 && d[0] >= '5';
      buf[o++] = up && digits_n == 0 ? '1' : '0';
      if (digits_n > 0) {
        buf[o++] = '.';
        for (int i = 0; i < digits_n; i++) buf[o++] = (up && i == digits_n - 1) ? '1' : '0';
      }
      buf[o] = 0;
      return ascii(buf);
    }
    int carry = round_digits(d, len, keep, r);
    int ip = point + carry; /* digits before the point */
    int rl = keep + carry;
    if (ip <= 0) {
      buf[o++] = '0';
    } else
      for (int i = 0; i < ip; i++) buf[o++] = r[i];
    if (digits_n > 0) {
      buf[o++] = '.';
      for (int i = 0; i < digits_n; i++) {
        int at = ip + i;
        buf[o++] = at >= 0 && at < rl ? r[at] : '0';
      }
    }
    buf[o] = 0;
    return ascii(buf);
  }
  /* toExponential with no digits given: as many as the shortest round-trip needs. */
  if (which == 2 && arg == YK_UNDEFINED) {
    if (a == 0) return ascii(neg ? "-0e+0" : "0e+0");
    yk_string *sh = str(number_to_string(a));
    char t[64], sc[64];
    for (uint32_t i = 0; i < sh->len && i < 63; i++) sc[i] = (char)sh->units[i];
    sc[sh->len < 63 ? sh->len : 63] = 0;
    int k = 0, dot = -1, exp10 = 0;
    for (uint32_t i = 0; i < sh->len; i++) {
      uint16_t c = sh->units[i];
      if (c == 'e') {
        exp10 = atoi(sc + i + 1 + (sc[i + 1] == '+'));
        break;
      }
      if (c == '.') dot = k;
      else t[k++] = (char)c;
    }
    int intdigits = dot < 0 ? k : dot;
    int first = 0;
    while (first < k - 1 && t[first] == '0') first++;
    int e10 = exp10 + intdigits - first - 1;
    int last = k;
    while (last > first + 1 && t[last - 1] == '0') last--;
    buf[o++] = t[first];
    if (last > first + 1) {
      buf[o++] = '.';
      for (int i = first + 1; i < last; i++) buf[o++] = t[i];
    }
    o += snprintf(buf + o, 16, "e%c%d", e10 < 0 ? '-' : '+', abs(e10));
    return ascii(buf);
  }
  int sig = which == 1 ? digits_n : digits_n + 1;
  int e10;
  if (a == 0) {
    for (int i = 0; i < sig; i++) r[i] = '0';
    r[sig] = 0;
    e10 = 0;
  } else {
    int carry = round_digits(d, len, sig, r);
    e10 = point - 1 + carry;
    r[sig] = 0;
  }
  if (which == 2 || e10 < -6 || e10 >= sig) {
    buf[o++] = r[0];
    if (sig > 1) {
      buf[o++] = '.';
      for (int i = 1; i < sig; i++) buf[o++] = r[i];
    }
    o += snprintf(buf + o, 16, "e%c%d", e10 < 0 ? '-' : '+', abs(e10));
  } else if (e10 >= 0) {
    for (int i = 0; i <= e10; i++) buf[o++] = r[i];
    if (sig > e10 + 1) {
      buf[o++] = '.';
      for (int i = e10 + 1; i < sig; i++) buf[o++] = r[i];
    }
  } else {
    buf[o++] = '0';
    buf[o++] = '.';
    for (int i = 0; i < -e10 - 1; i++) buf[o++] = '0';
    for (int i = 0; i < sig; i++) buf[o++] = r[i];
  }
  buf[o] = 0;
  return ascii(buf);
}

/* --- Math, with JavaScript's results --- */

yk yk_math1(const char *name, yk a) {
  double x = to_number(a);
  if (strcmp(name, "floor") == 0) return yk_number(floor(x));
  if (strcmp(name, "ceil") == 0) return yk_number(ceil(x));
  if (strcmp(name, "trunc") == 0) return yk_number(trunc(x));
  if (strcmp(name, "sqrt") == 0) return yk_number(sqrt(x));
  if (strcmp(name, "abs") == 0) return yk_number(fabs(x));
  if (strcmp(name, "sign") == 0) return yk_number(x > 0 ? 1 : x < 0 ? -1 : x);
  if (strcmp(name, "round") == 0) {
    double r = floor(x);
    if (x - r >= 0.5) r += 1;
    return yk_number(r == 0 ? copysign(0, x) : r);
  }
  return yk_number(NAN);
}

static double minmax(int max, double a, double b) {
  if (a != a || b != b) return NAN;
  if (a == b) {
    uint64_t x, y, r;
    memcpy(&x, &a, 8);
    memcpy(&y, &b, 8);
    r = max ? (x & y) : (x | y);
    memcpy(&a, &r, 8);
    return a;
  }
  return max ? (a > b ? a : b) : (a < b ? a : b);
}

yk yk_math_minmax(int max, uint64_t argc, const yk *argv);
/* Math.min(...xs) / Math.max(...xs): the expanded list. */
yk yk_math_minmax_list(int max, yk list) { return yk_math_minmax(max, arr(list)->len, arr(list)->items); }
yk yk_math_minmax(int max, uint64_t argc, const yk *argv) {
  double r = max ? -INFINITY : INFINITY;
  for (uint64_t i = 0; i < argc; i++) r = minmax(max, r, to_number(argv[i]));
  return yk_number(r);
}

/* --- the host boundary: values in a line-oriented text form --- */
/*   n<16 hex digits>  a number, by its bits    s<count>:<4 hex digits per code unit>  a string
 *   u  undefined   l  null   t  true   f  false   a<count> then the elements
 *   b<decimal digits>  a BigInt                                                         */

/* The host form's numbers: whitespace, then up to max digits of a base (at least one). */
static int read_digits(FILE *in, int base, int max, unsigned long long *out) {
  int c;
  do c = fgetc(in);
  while (c == ' ' || c == '\n' || c == '\t' || c == '\r');
  unsigned long long v = 0;
  int n = 0;
  for (; n < max; n++) {
    int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 99;
    if (d >= base) break;
    v = v * (unsigned)base + (unsigned)d;
    c = fgetc(in);
  }
  ungetc(c, in);
  *out = v;
  return n > 0;
}
static unsigned read_count(FILE *in) {
  unsigned long long v;
  if (!read_digits(in, 10, 10, &v)) exit(65);
  return (unsigned)v;
}
yk yk_read(FILE *in) {
  int c;
  do c = fgetc(in);
  while (c == ' ' || c == '\n');
  if (c == EOF) exit(0);
  if (c == 'n') {
    unsigned long long bits;
    if (!read_digits(in, 16, 16, &bits)) exit(65);
    double d;
    memcpy(&d, &bits, 8);
    return yk_number(d);
  }
  if (c == 's') {
    unsigned len = read_count(in);
    int colon = fgetc(in);
    if (colon != ':') ungetc(colon, in);
    yk_string *s = new_string(len);
    for (unsigned i = 0; i < len; i++) {
      unsigned long long u;
      if (!read_digits(in, 16, 4, &u)) exit(65);
      s->units[i] = (uint16_t)u;
    }
    return string_of(s);
  }
  if (c == 'a') {
    unsigned len = read_count(in);
    yk_array *a = new_array(len);
    for (unsigned i = 0; i < len; i++) push(a, yk_read(in));
    return BOX(T_ARRAY, a);
  }
  if (c == 'o') {
    unsigned len = read_count(in);
    yk_object *o = alloc(sizeof(yk_object));
    o->len = o->cap = 0;
    o->error = 0;
    o->keys = o->values = NULL;
    o->index = NULL;
    o->index_cap = 0;
    for (unsigned i = 0; i < len; i++) {
      yk k = yk_read(in);
      own_set(o, k, yk_read(in));
    }
    return BOX(T_OBJECT, o);
  }
  if (c == 'b') {
    /* A BigInt: its decimal digits, a minus first if negative. */
    char buf[4096];
    size_t bn = 0;
    int ch;
    while (bn < sizeof buf - 1 && ((ch = fgetc(in)) == '-' || (ch >= '0' && ch <= '9'))) buf[bn++] = (char)ch;
    if (bn < sizeof buf - 1) ungetc(ch, in);
    if (bn == 0) exit(65);
    buf[bn] = 0;
    int neg = buf[0] == '-';
    size_t n = strlen(buf + neg);
    uint16_t *u = alloc(n * 2 + 2);
    for (size_t i = 0; i < n; i++) u[i] = (uint8_t)buf[neg + i];
    yk v = big_from_units(u, (uint32_t)n, 1);
    return neg ? big_negate(v) : v;
  }
  if (c == 'u') return YK_UNDEFINED;
  if (c == 'l') return YK_NULL;
  if (c == 't') return YK_TRUE;
  if (c == 'f') return YK_FALSE;
  exit(65);
}

void yk_write(FILE *out, yk v) {
  if (is_number(v)) {
    double d = num(v);
    unsigned long long bits;
    memcpy(&bits, &d, 8);
    fprintf(out, "n%016llx", bits);
  } else if (is_string(v)) {
    yk_string *s = str(v);
    fprintf(out, "s%u:", s->len);
    for (uint32_t i = 0; i < s->len; i++) fprintf(out, "%04x", s->units[i]);
  } else if (is_array(v)) {
    yk_array *a = arr(v);
    fprintf(out, "a%u", a->len);
    for (uint32_t i = 0; i < a->len; i++) {
      fputc(' ', out);
      yk_write(out, a->items[i]);
    }
  } else if (is_object(v) && ((yk_object *)PTR(v))->kind == 7) {
    /* A typed array: its elements, as an array's. */
    yk_write(out, BOX(T_ARRAY, typed_items_v(v)));
  } else if (is_object(v)) {
    yk_object *o = (yk_object *)PTR(v);
    yk_array *keys = enumerable_keys(o);
    fprintf(out, "o%u", keys->len);
    for (uint32_t i = 0; i < keys->len; i++) {
      yk value;
      own_get(o, keys->items[i], &value);
      value = resolve_slot(value, v);
      fputc(' ', out);
      yk_write(out, keys->items[i]);
      fputc(' ', out);
      yk_write(out, value);
    }
  } else if (is_closure(v))
    fputc('F', out);
  else if (is_bigint(v)) {
    yk_string *s = str(big_to_string_v(v));
    fputc('b', out);
    for (uint32_t i = 0; i < s->len; i++) fputc((char)s->units[i], out);
  } else
    fputc(v == YK_UNDEFINED ? 'u' : v == YK_NULL ? 'l' : v == YK_TRUE ? 't' : 'f', out);
}
