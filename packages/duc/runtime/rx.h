/* SPDX-License-Identifier: Apache-2.0 */
/*
 * Regular expressions compiled at run time (`new RegExp(string)`, #1331): a backtracking matcher
 * over a parsed pattern, with the interface and the semantics of the matchers regex.ts compiles for
 * literals (DEC-DUC-REGEX-GRAPH-001). The matcher is a closure `f(s, start, sticky)` giving the
 * first match at or after `start` (only at `start` when sticky) as [start, end, g1s, g1e, …] (-1
 * for a group that did not take part), or null. It backtracks as ECMAScript's pattern semantics
 * say: alternatives in order, greedy and lazy quantifiers, the empty check, captures reset on each
 * repetition, lookahead, lookbehind (matched backward), backreferences.
 *
 * Covered, as regex.ts covers: flags d g i m s u y; alternation; groups (capturing, named,
 * non-capturing); quantifiers (* + ? {n,m}, lazy); classes and \d \w \s and their negations;
 * ^ $ \b \B; lookahead and lookbehind; backreferences (numbered, named); the character escapes.
 * Case folding is ASCII and Latin-1. Refused (a SyntaxError): Unicode property escapes, the v flag.
 *
 * Included by yk.c, which gives the value model.
 */

enum { RX_CHAR, RX_ANY, RX_CLASS, RX_SEQ, RX_ALT, RX_GROUP, RX_REPEAT, RX_BOL, RX_EOL, RX_BOUND, RX_LOOK, RX_BACKREF };

typedef struct rx_node {
  int t;
  int c;                 /* RX_CHAR: the code point (upper-cased when folding) */
  int negate;            /* RX_CLASS, RX_BOUND, RX_LOOK */
  int behind;            /* RX_LOOK: a lookbehind */
  int index;             /* RX_GROUP: its number, or 0 (non-capturing); RX_BACKREF: the group */
  int min, max;          /* RX_REPEAT: max -1 for no bound */
  int greedy;
  int nranges;           /* RX_CLASS: [lo, hi] pairs */
  int *ranges;
  int n;                 /* RX_SEQ, RX_ALT: the items */
  struct rx_node **items;
  struct rx_node *body;  /* RX_GROUP, RX_REPEAT, RX_LOOK */
  int ngroups_within;    /* RX_REPEAT, RX_LOOK: the groups inside, reset on each repetition */
  int *groups_within;
  char *ref_name;        /* RX_BACKREF by name, until resolved */
} rx_node;

typedef struct {
  const uint16_t *p;
  uint32_t len, at;
  int unicode, fold;
  int groups;
  char **names; /* each group's name, or NULL; names[g - 1] */
  int names_cap;
  rx_node **named_refs;
  int nrefs, refs_cap;
  const char *error;
} rx_parser;

static rx_node *rx_new(int t) {
  rx_node *n = calloc(1, sizeof(rx_node));
  n->t = t;
  return n;
}
static void rx_push(rx_node ***items, int *n, int *cap, rx_node *x) {
  if (*n == *cap) {
    *cap = *cap ? *cap * 2 : 4;
    *items = realloc(*items, (size_t)*cap * sizeof(rx_node *));
  }
  (*items)[(*n)++] = x;
}
static void rx_add_range(int **ranges, int *n, int *cap, int lo, int hi) {
  if (*n + 2 > *cap) {
    *cap = *cap ? *cap * 2 : 8;
    *ranges = realloc(*ranges, (size_t)*cap * sizeof(int));
  }
  (*ranges)[(*n)++] = lo;
  (*ranges)[(*n)++] = hi;
}

static const int rx_digit[] = {48, 57};
static const int rx_word[] = {48, 57, 65, 90, 95, 95, 97, 122};
static const int rx_space[] = {9, 13, 32, 32, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029,
                               0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff};

static int rx_peek(rx_parser *ps) { return ps->at < ps->len ? ps->p[ps->at] : -1; }
static int rx_fail(rx_parser *ps, const char *why) {
  if (ps->error == NULL) ps->error = why;
  ps->at = ps->len;
  return -1;
}
static int rx_code_point(rx_parser *ps) {
  int c = ps->p[ps->at++];
  if (ps->unicode && c >= 0xD800 && c <= 0xDBFF && ps->at < ps->len && ps->p[ps->at] >= 0xDC00 && ps->p[ps->at] <= 0xDFFF)
    c = (c - 0xD800) * 1024 + (ps->p[ps->at++] - 0xDC00) + 0x10000;
  return c;
}
static int rx_hexval(int c) {
  return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}
static int rx_hex(rx_parser *ps, int n) {
  if (ps->at + (uint32_t)n > ps->len) return -1;
  int v = 0;
  for (int i = 0; i < n; i++) {
    int h = rx_hexval(ps->p[ps->at + (uint32_t)i]);
    if (h < 0) return -1;
    v = v * 16 + h;
  }
  ps->at += (uint32_t)n;
  return v;
}
/* A character escape after `\` (not a class escape or a backreference): its code point. */
static int rx_char_escape(rx_parser *ps, int in_class) {
  int e = ps->p[ps->at++];
  switch (e) {
  case 't': return 9;
  case 'n': return 10;
  case 'v': return 11;
  case 'f': return 12;
  case 'r': return 13;
  }
  if (e == '0' && !(rx_peek(ps) >= '0' && rx_peek(ps) <= '9')) return 0;
  if (e == 'b' && in_class) return 8;
  if (e == 'c') {
    int l = rx_peek(ps);
    if ((l >= 'A' && l <= 'Z') || (l >= 'a' && l <= 'z')) {
      ps->at++;
      return l % 32;
    }
    ps->at--;
    return 92;
  }
  if (e == 'x') {
    int v = rx_hex(ps, 2);
    return v >= 0 ? v : ps->unicode ? rx_fail(ps, "Invalid escape") : 'x';
  }
  if (e == 'u') {
    if (ps->unicode && rx_peek(ps) == '{') {
      ps->at++;
      int v = 0, digits = 0;
      while (ps->at < ps->len && rx_hexval(ps->p[ps->at]) >= 0 && v <= 0x10ffff) v = v * 16 + rx_hexval(ps->p[ps->at++]), digits++;
      if (rx_peek(ps) != '}' || digits == 0 || v > 0x10ffff) return rx_fail(ps, "Invalid Unicode escape");
      ps->at++;
      return v;
    }
    int v = rx_hex(ps, 4);
    if (v < 0) return ps->unicode ? rx_fail(ps, "Invalid Unicode escape") : 'u';
    if (ps->unicode && v >= 0xD800 && v <= 0xDBFF && ps->at + 6 <= ps->len && ps->p[ps->at] == '\\' && ps->p[ps->at + 1] == 'u') {
      uint32_t save = ps->at;
      ps->at += 2;
      int lo = rx_hex(ps, 4);
      if (lo >= 0xDC00 && lo <= 0xDFFF) return (v - 0xD800) * 1024 + (lo - 0xDC00) + 0x10000;
      ps->at = save;
    }
    return v;
  }
  if (e == 'p' || e == 'P') {
    if (ps->unicode) return rx_fail(ps, "Unicode property escapes are not in the native runtime yet");
    return e;
  }
  if (ps->unicode && !strchr("^$\\.*+?()[]{}|/-", e)) return rx_fail(ps, "Invalid escape");
  ps->at--;
  return rx_code_point(ps);
}
/* A class escape (\d \D \w \W \s \S) into ranges; 0 if the escape is not one. */
static int rx_class_escape(rx_parser *ps, int **ranges, int *n, int *cap) {
  int e = rx_peek(ps);
  const int *set = NULL;
  int count = 0, negate = 0;
  if (e == 'd' || e == 'D') set = rx_digit, count = 2, negate = e == 'D';
  else if (e == 'w' || e == 'W') set = rx_word, count = 8, negate = e == 'W';
  else if (e == 's' || e == 'S') set = rx_space, count = 20, negate = e == 'S';
  else return 0;
  ps->at++;
  if (!negate)
    for (int i = 0; i < count; i += 2) rx_add_range(ranges, n, cap, set[i], set[i + 1]);
  else {
    int at = 0;
    for (int i = 0; i < count; i += 2) {
      if (set[i] > at) rx_add_range(ranges, n, cap, at, set[i] - 1);
      at = set[i + 1] + 1;
    }
    rx_add_range(ranges, n, cap, at, 0x10ffff);
  }
  return 1;
}
static rx_node *rx_class_node(const int *set, int count, int negate) {
  rx_node *x = rx_new(RX_CLASS);
  int cap = 0;
  for (int i = 0; i < count; i += 2) rx_add_range(&x->ranges, &x->nranges, &cap, set[i], set[i + 1]);
  x->negate = negate;
  return x;
}
static rx_node *rx_parse_class(rx_parser *ps) {
  rx_node *x = rx_new(RX_CLASS);
  int cap = 0;
  if (rx_peek(ps) == '^') x->negate = 1, ps->at++;
  while (ps->at < ps->len && ps->p[ps->at] != ']') {
    int lo;
    if (ps->p[ps->at] == '\\') {
      ps->at++;
      if (ps->at >= ps->len) return rx_fail(ps, "\\ at end of pattern"), x;
      if (rx_class_escape(ps, &x->ranges, &x->nranges, &cap)) {
        if (rx_peek(ps) == '-' && ps->at + 1 < ps->len && ps->p[ps->at + 1] != ']' && ps->unicode)
          return rx_fail(ps, "Invalid character class"), x;
        continue;
      }
      lo = rx_char_escape(ps, 1);
    } else
      lo = rx_code_point(ps);
    if (rx_peek(ps) == '-' && ps->at + 1 < ps->len && ps->p[ps->at + 1] != ']') {
      ps->at++;
      int hi;
      if (ps->p[ps->at] == '\\') {
        ps->at++;
        int before = x->nranges;
        if (rx_class_escape(ps, &x->ranges, &x->nranges, &cap)) {
          if (ps->unicode) return rx_fail(ps, "Invalid character class"), x;
          /* [a-\d]: the a, a -, and the class, as Annex B reads it. */
          (void)before;
          rx_add_range(&x->ranges, &x->nranges, &cap, lo, lo);
          rx_add_range(&x->ranges, &x->nranges, &cap, '-', '-');
          continue;
        }
        hi = rx_char_escape(ps, 1);
      } else
        hi = rx_code_point(ps);
      if (hi < lo) return rx_fail(ps, "Range out of order in character class"), x;
      rx_add_range(&x->ranges, &x->nranges, &cap, lo, hi);
    } else
      rx_add_range(&x->ranges, &x->nranges, &cap, lo, lo);
  }
  if (rx_peek(ps) != ']') return rx_fail(ps, "Unterminated character class"), x;
  ps->at++;
  return x;
}
static rx_node *rx_parse_alt(rx_parser *ps);
static void rx_set_name(rx_parser *ps, int g, char *name) {
  if (g > ps->names_cap) {
    int cap = ps->names_cap ? ps->names_cap * 2 : 8;
    while (cap < g) cap *= 2;
    ps->names = realloc(ps->names, (size_t)cap * sizeof(char *));
    for (int i = ps->names_cap; i < cap; i++) ps->names[i] = NULL;
    ps->names_cap = cap;
  }
  ps->names[g - 1] = name;
}
/* A group name after `<`, up to `>`, as UTF-8 (identifier characters). */
static char *rx_group_name(rx_parser *ps) {
  uint32_t start = ps->at;
  while (ps->at < ps->len && ps->p[ps->at] != '>') ps->at++;
  if (ps->at >= ps->len || ps->at == start) return rx_fail(ps, "Invalid capture group name"), NULL;
  uint32_t n = ps->at - start;
  char *name = malloc(n * 3 + 1);
  uint32_t k = 0;
  for (uint32_t i = 0; i < n; i++) {
    uint16_t c = ps->p[start + i];
    int ok = c == '$' || c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9' && i > 0) || c >= 0x80;
    if (!ok) return free(name), rx_fail(ps, "Invalid capture group name"), NULL;
    if (c < 0x80) name[k++] = (char)c;
    else if (c < 0x800) name[k++] = (char)(0xC0 | (c >> 6)), name[k++] = (char)(0x80 | (c & 63));
    else name[k++] = (char)(0xE0 | (c >> 12)), name[k++] = (char)(0x80 | ((c >> 6) & 63)), name[k++] = (char)(0x80 | (c & 63));
  }
  name[k] = 0;
  ps->at++;
  return name;
}
static int rx_total_groups(const uint16_t *p, uint32_t len) {
  int n = 0, in_class = 0;
  for (uint32_t i = 0; i < len; i++) {
    if (p[i] == '\\') {
      i++;
      continue;
    }
    if (in_class) {
      if (p[i] == ']') in_class = 0;
      continue;
    }
    if (p[i] == '[') in_class = 1;
    else if (p[i] == '(' && !(i + 1 < len && p[i + 1] == '?' && !(i + 2 < len && p[i + 2] == '<' && i + 3 < len && p[i + 3] != '=' && p[i + 3] != '!')))
      n++;
  }
  return n;
}
static int rx_total;
static rx_node *rx_parse_atom(rx_parser *ps) {
  int c = ps->p[ps->at];
  if (c == '.') return ps->at++, rx_new(RX_ANY);
  if (c == '^') return ps->at++, rx_new(RX_BOL);
  if (c == '$') return ps->at++, rx_new(RX_EOL);
  if (c == '[') return ps->at++, rx_parse_class(ps);
  if (c == '(') {
    ps->at++;
    if (ps->at + 1 < ps->len && ps->p[ps->at] == '?' && ps->p[ps->at + 1] == ':') {
      ps->at += 2;
      rx_node *g = rx_new(RX_GROUP);
      g->body = rx_parse_alt(ps);
      if (rx_peek(ps) != ')') return rx_fail(ps, "Unterminated group"), g;
      ps->at++;
      return g;
    }
    if (ps->at + 1 < ps->len && ps->p[ps->at] == '?' && (ps->p[ps->at + 1] == '=' || ps->p[ps->at + 1] == '!')) {
      rx_node *l = rx_new(RX_LOOK);
      l->negate = ps->p[ps->at + 1] == '!';
      ps->at += 2;
      l->body = rx_parse_alt(ps);
      if (rx_peek(ps) != ')') return rx_fail(ps, "Unterminated group"), l;
      ps->at++;
      return l;
    }
    if (ps->at + 2 < ps->len && ps->p[ps->at] == '?' && ps->p[ps->at + 1] == '<' && (ps->p[ps->at + 2] == '=' || ps->p[ps->at + 2] == '!')) {
      rx_node *l = rx_new(RX_LOOK);
      l->negate = ps->p[ps->at + 2] == '!';
      l->behind = 1;
      ps->at += 3;
      l->body = rx_parse_alt(ps);
      if (rx_peek(ps) != ')') return rx_fail(ps, "Unterminated group"), l;
      ps->at++;
      return l;
    }
    char *name = NULL;
    if (ps->at + 1 < ps->len && ps->p[ps->at] == '?' && ps->p[ps->at + 1] == '<') {
      ps->at += 2;
      name = rx_group_name(ps);
    } else if (rx_peek(ps) == '?')
      return rx_fail(ps, "Invalid group"), rx_new(RX_SEQ);
    rx_node *g = rx_new(RX_GROUP);
    g->index = ++ps->groups;
    rx_set_name(ps, g->index, name);
    g->body = rx_parse_alt(ps);
    if (rx_peek(ps) != ')') return rx_fail(ps, "Unterminated group"), g;
    ps->at++;
    return g;
  }
  if (c == '\\') {
    ps->at++;
    if (ps->at >= ps->len) return rx_fail(ps, "\\ at end of pattern"), rx_new(RX_SEQ);
    int e = ps->p[ps->at];
    if (e == 'b' || e == 'B') {
      ps->at++;
      rx_node *b = rx_new(RX_BOUND);
      b->negate = e == 'B';
      return b;
    }
    if (e == 'd' || e == 'D') return ps->at++, rx_class_node(rx_digit, 2, e == 'D');
    if (e == 'w' || e == 'W') return ps->at++, rx_class_node(rx_word, 8, e == 'W');
    if (e == 's' || e == 'S') return ps->at++, rx_class_node(rx_space, 20, e == 'S');
    if (e >= '1' && e <= '9') {
      uint32_t save = ps->at;
      int v = 0;
      while (ps->at < ps->len && ps->p[ps->at] >= '0' && ps->p[ps->at] <= '9') v = v * 10 + (ps->p[ps->at++] - '0');
      if (v <= rx_total) {
        rx_node *r = rx_new(RX_BACKREF);
        r->index = v;
        return r;
      }
      if (ps->unicode) return rx_fail(ps, "Invalid escape"), rx_new(RX_SEQ);
      ps->at = save;
      /* Annex B: a legacy octal escape, or the digit itself. */
      if (e <= '7') {
        int o = 0, k = 0;
        while (k < 3 && ps->at < ps->len && ps->p[ps->at] >= '0' && ps->p[ps->at] <= '7' && o * 8 + (ps->p[ps->at] - '0') <= 255)
          o = o * 8 + (ps->p[ps->at++] - '0'), k++;
        rx_node *ch = rx_new(RX_CHAR);
        ch->c = o;
        return ch;
      }
      ps->at++;
      rx_node *ch = rx_new(RX_CHAR);
      ch->c = e;
      return ch;
    }
    if (e == 'k' && ps->at + 1 < ps->len && ps->p[ps->at + 1] == '<') {
      ps->at += 2;
      rx_node *r = rx_new(RX_BACKREF);
      r->ref_name = rx_group_name(ps);
      if (ps->nrefs == ps->refs_cap) {
        ps->refs_cap = ps->refs_cap ? ps->refs_cap * 2 : 4;
        ps->named_refs = realloc(ps->named_refs, (size_t)ps->refs_cap * sizeof(rx_node *));
      }
      ps->named_refs[ps->nrefs++] = r;
      return r;
    }
    rx_node *ch = rx_new(RX_CHAR);
    ch->c = rx_char_escape(ps, 0);
    return ch;
  }
  if (c == ')' ) return rx_fail(ps, "Unmatched ')'"), rx_new(RX_SEQ);
  if (c == '*' || c == '+' || c == '?') return rx_fail(ps, "Nothing to repeat"), rx_new(RX_SEQ);
  if (c == '{' && ps->unicode) return rx_fail(ps, "Lone quantifier brackets"), rx_new(RX_SEQ);
  if ((c == '}' || c == ']') && ps->unicode) return rx_fail(ps, "Lone quantifier brackets"), rx_new(RX_SEQ);
  rx_node *ch = rx_new(RX_CHAR);
  ch->c = rx_code_point(ps);
  return ch;
}
/* {n}, {n,}, {n,m} at the parser's position: 1 and the bounds, or 0 (not a quantifier). */
static int rx_braces(rx_parser *ps, int *min, int *max) {
  uint32_t i = ps->at + 1;
  if (i >= ps->len || !(ps->p[i] >= '0' && ps->p[i] <= '9')) return 0;
  double lo = 0, hi;
  while (i < ps->len && ps->p[i] >= '0' && ps->p[i] <= '9') lo = lo * 10 + (ps->p[i++] - '0');
  hi = lo;
  if (i < ps->len && ps->p[i] == ',') {
    i++;
    if (i < ps->len && ps->p[i] >= '0' && ps->p[i] <= '9') {
      hi = 0;
      while (i < ps->len && ps->p[i] >= '0' && ps->p[i] <= '9') hi = hi * 10 + (ps->p[i++] - '0');
    } else
      hi = -1;
  }
  if (i >= ps->len || ps->p[i] != '}') return 0;
  ps->at = i + 1;
  *min = lo > 1e9 ? 1000000000 : (int)lo;
  *max = hi < 0 ? -1 : hi > 1e9 ? 1000000000 : (int)hi;
  if (*max >= 0 && *max < *min) return rx_fail(ps, "numbers out of order in {} quantifier"), 0;
  return 1;
}
static rx_node *rx_parse_term(rx_parser *ps) {
  int c = ps->p[ps->at];
  if (c == '{' && !ps->unicode) {
    int mn, mx;
    uint32_t save = ps->at;
    if (rx_braces(ps, &mn, &mx)) return rx_fail(ps, "Nothing to repeat"), rx_new(RX_SEQ);
    ps->at = save;
    ps->at++;
    rx_node *ch = rx_new(RX_CHAR);
    ch->c = '{';
    return ch;
  }
  rx_node *atom = rx_parse_atom(ps);
  if (ps->error != NULL) return atom;
  int is_assertion = atom->t == RX_BOL || atom->t == RX_EOL || atom->t == RX_BOUND || (atom->t == RX_LOOK && (atom->behind || ps->unicode));
  int mn, mx;
  int q = rx_peek(ps);
  if (q == '*') ps->at++, mn = 0, mx = -1;
  else if (q == '+') ps->at++, mn = 1, mx = -1;
  else if (q == '?') ps->at++, mn = 0, mx = 1;
  else if (q == '{' && rx_braces(ps, &mn, &mx)) ;
  else return atom;
  if (ps->error != NULL) return atom;
  if (is_assertion) return rx_fail(ps, "Nothing to repeat"), atom;
  rx_node *r = rx_new(RX_REPEAT);
  r->min = mn, r->max = mx, r->greedy = 1, r->body = atom;
  if (rx_peek(ps) == '?') ps->at++, r->greedy = 0;
  return r;
}
static rx_node *rx_parse_seq(rx_parser *ps) {
  rx_node *s = rx_new(RX_SEQ);
  int cap = 0;
  while (ps->at < ps->len && ps->p[ps->at] != '|' && ps->p[ps->at] != ')') {
    rx_push(&s->items, &s->n, &cap, rx_parse_term(ps));
    if (ps->error != NULL) break;
  }
  return s;
}
static rx_node *rx_parse_alt(rx_parser *ps) {
  rx_node *first = rx_parse_seq(ps);
  if (rx_peek(ps) != '|') return first;
  rx_node *a = rx_new(RX_ALT);
  int cap = 0;
  rx_push(&a->items, &a->n, &cap, first);
  while (rx_peek(ps) == '|' && ps->error == NULL) {
    ps->at++;
    rx_push(&a->items, &a->n, &cap, rx_parse_seq(ps));
  }
  return a;
}
static void rx_groups_within(rx_node *n, int **out, int *count, int *cap) {
  if (n == NULL) return;
  if (n->t == RX_GROUP && n->index > 0) {
    if (*count == *cap) *cap = *cap ? *cap * 2 : 4, *out = realloc(*out, (size_t)*cap * sizeof(int));
    (*out)[(*count)++] = n->index;
  }
  for (int i = 0; i < n->n; i++) rx_groups_within(n->items[i], out, count, cap);
  rx_groups_within(n->body, out, count, cap);
}
static void rx_prepare(rx_node *n) {
  if (n == NULL) return;
  if (n->t == RX_REPEAT || n->t == RX_LOOK) {
    int cap = 0;
    rx_groups_within(n->body, &n->groups_within, &n->ngroups_within, &cap);
  }
  for (int i = 0; i < n->n; i++) rx_prepare(n->items[i]);
  rx_prepare(n->body);
}

/* --- matching --- */

static int rx_upper(int c) {
  if (c >= 97 && c <= 122) return c - 32;
  if (c >= 0xe0 && c <= 0xfe && c != 0xf7) return c - 32;
  if (c == 0xff) return 0x178;
  if (c == 0xb5) return 0x39c;
  return c;
}
static int rx_lower(int c) {
  if (c >= 65 && c <= 90) return c + 32;
  if (c >= 0xc0 && c <= 0xde && c != 0xd7) return c + 32;
  if (c == 0x178) return 0xff;
  return c;
}
static void rx_fold_chars(rx_node *n) {
  if (n == NULL) return;
  if (n->t == RX_CHAR) n->c = rx_upper(n->c);
  for (int i = 0; i < n->n; i++) rx_fold_chars(n->items[i]);
  rx_fold_chars(n->body);
}

typedef struct {
  const uint16_t *s;
  int n;
  int *caps;
  int unicode, fold, multiline, dot_all;
  long steps;
} rx_m;
typedef struct rx_k rx_k;
struct rx_k {
  int (*f)(rx_m *, rx_k *, int);
  rx_node *node;
  int x, y, back;
  rx_k *next;
};
static int rx_match(rx_m *m, rx_node *nd, int i, rx_k *k, int back);
static int rx_call(rx_m *m, rx_k *k, int j) { return k->f(m, k, j); }

static int rx_in_ranges(rx_node *nd, int c) {
  for (int r = 0; r < nd->nranges; r += 2)
    if (c >= nd->ranges[r] && c <= nd->ranges[r + 1]) return 1;
  return 0;
}
static int rx_line_terminator(int c) { return c == 10 || c == 13 || c == 8232 || c == 8233; }
static int rx_word_char(int c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c == 95 || (c >= 97 && c <= 122); }
/* The character at i (forward) or ending at i (backward), and its width; 0 at the end. */
static int rx_read(rx_m *m, int i, int back, int *c) {
  if (back) {
    if (i <= 0) return 0;
    int lo = m->s[i - 1];
    if (m->unicode && lo >= 0xDC00 && lo <= 0xDFFF && i >= 2 && m->s[i - 2] >= 0xD800 && m->s[i - 2] <= 0xDBFF) {
      *c = (m->s[i - 2] - 0xD800) * 1024 + (lo - 0xDC00) + 0x10000;
      return 2;
    }
    *c = lo;
    return 1;
  }
  if (i >= m->n) return 0;
  int hi = m->s[i];
  if (m->unicode && hi >= 0xD800 && hi <= 0xDBFF && i + 1 < m->n && m->s[i + 1] >= 0xDC00 && m->s[i + 1] <= 0xDFFF) {
    *c = (hi - 0xD800) * 1024 + (m->s[i + 1] - 0xDC00) + 0x10000;
    return 2;
  }
  *c = hi;
  return 1;
}
static int rx_seq_k(rx_m *m, rx_k *k, int j);
static int rx_seq_from(rx_m *m, rx_node *nd, int idx, int i, rx_k *k, int back) {
  if (idx == nd->n) return rx_call(m, k, i);
  rx_k kk = {rx_seq_k, nd, idx + 1, 0, back, k};
  return rx_match(m, nd->items[back ? nd->n - 1 - idx : idx], i, &kk, back);
}
static int rx_seq_k(rx_m *m, rx_k *k, int j) { return rx_seq_from(m, k->node, k->x, j, k->next, k->back); }
static int rx_group_k(rx_m *m, rx_k *k, int j) {
  int g = k->node->index, *caps = m->caps;
  int qs = caps[2 * g], qe = caps[2 * g + 1];
  caps[2 * g] = k->back ? j : k->y;
  caps[2 * g + 1] = k->back ? k->y : j;
  if (rx_call(m, k->next, j)) return 1;
  caps[2 * g] = qs, caps[2 * g + 1] = qe;
  return 0;
}
static int rx_repeat(rx_m *m, rx_node *nd, int i, int count, rx_k *k, int back);
static int rx_repeat_k(rx_m *m, rx_k *k, int j) {
  /* The empty check: an empty iteration once the minimum is met fails. */
  if (j == k->y && k->x >= k->node->min) return 0;
  return rx_repeat(m, k->node, j, k->x + 1, k->next, k->back);
}
static int rx_repeat_more(rx_m *m, rx_node *nd, int i, int count, rx_k *k, int back) {
  int saved[2 * 64], *heap = NULL, *keep = saved;
  int ng = nd->ngroups_within;
  if (ng > 64) heap = keep = malloc((size_t)ng * 2 * sizeof(int));
  for (int g = 0; g < ng; g++) {
    int x = nd->groups_within[g];
    keep[2 * g] = m->caps[2 * x], keep[2 * g + 1] = m->caps[2 * x + 1];
    m->caps[2 * x] = -1, m->caps[2 * x + 1] = -1;
  }
  rx_k kk = {rx_repeat_k, nd, count, i, back, k};
  int ok = rx_match(m, nd->body, i, &kk, back);
  if (!ok)
    for (int g = 0; g < ng; g++) {
      int x = nd->groups_within[g];
      m->caps[2 * x] = keep[2 * g], m->caps[2 * x + 1] = keep[2 * g + 1];
    }
  free(heap);
  return ok;
}
static int rx_repeat(rx_m *m, rx_node *nd, int i, int count, rx_k *k, int back) {
  if (nd->max >= 0 && count >= nd->max) return rx_call(m, k, i);
  if (count < nd->min) return rx_repeat_more(m, nd, i, count, k, back);
  if (nd->greedy) return rx_repeat_more(m, nd, i, count, k, back) || rx_call(m, k, i);
  return rx_call(m, k, i) || rx_repeat_more(m, nd, i, count, k, back);
}
static int rx_accept(rx_m *m, rx_k *k, int j) { (void)m, (void)k, (void)j; return 1; }
static int rx_match(rx_m *m, rx_node *nd, int i, rx_k *k, int back) {
  int c, w;
  if (++m->steps > 50000000L) range_error("Maximum call stack size exceeded (regular expression)");
  switch (nd->t) {
  case RX_CHAR:
    if (!(w = rx_read(m, i, back, &c))) return 0;
    if ((m->fold ? rx_upper(c) : c) != nd->c) return 0;
    return rx_call(m, k, back ? i - w : i + w);
  case RX_ANY:
    if (!(w = rx_read(m, i, back, &c))) return 0;
    if (!m->dot_all && rx_line_terminator(c)) return 0;
    return rx_call(m, k, back ? i - w : i + w);
  case RX_CLASS: {
    if (!(w = rx_read(m, i, back, &c))) return 0;
    int in = rx_in_ranges(nd, c) || (m->fold && (rx_in_ranges(nd, rx_lower(c)) || rx_in_ranges(nd, rx_upper(c))));
    if (in == nd->negate) return 0;
    return rx_call(m, k, back ? i - w : i + w);
  }
  case RX_SEQ: return rx_seq_from(m, nd, 0, i, k, back);
  case RX_ALT:
    for (int a = 0; a < nd->n; a++)
      if (rx_match(m, nd->items[a], i, k, back)) return 1;
    return 0;
  case RX_GROUP: {
    if (nd->index == 0) return rx_match(m, nd->body, i, k, back);
    rx_k kk = {rx_group_k, nd, 0, i, back, k};
    return rx_match(m, nd->body, i, &kk, back);
  }
  case RX_REPEAT: return rx_repeat(m, nd, i, 0, k, back);
  case RX_BOL:
    if (i == 0 || (m->multiline && rx_line_terminator(m->s[i - 1]))) return rx_call(m, k, i);
    return 0;
  case RX_EOL:
    if (i == m->n || (m->multiline && rx_line_terminator(m->s[i]))) return rx_call(m, k, i);
    return 0;
  case RX_BOUND: {
    int a = i > 0 && rx_word_char(m->s[i - 1]), b = i < m->n && rx_word_char(m->s[i]);
    if ((a != b) == !nd->negate) return rx_call(m, k, i);
    return 0;
  }
  case RX_LOOK: {
    rx_k accept = {rx_accept, NULL, 0, 0, 0, NULL};
    int r = rx_match(m, nd->body, i, &accept, nd->behind);
    if (nd->negate) {
      if (r) {
        for (int g = 0; g < nd->ngroups_within; g++) m->caps[2 * nd->groups_within[g]] = -1, m->caps[2 * nd->groups_within[g] + 1] = -1;
        return 0;
      }
      return rx_call(m, k, i);
    }
    return r ? rx_call(m, k, i) : 0;
  }
  case RX_BACKREF: {
    int a = m->caps[2 * nd->index], b = m->caps[2 * nd->index + 1];
    if (a < 0 || b < 0) return rx_call(m, k, i);
    int len = b - a;
    int from = back ? i - len : i;
    if (from < 0 || from + len > m->n) return 0;
    for (int t = 0; t < len; t++) {
      int x = m->s[a + t], y = m->s[from + t];
      if ((m->fold ? rx_upper(x) : x) != (m->fold ? rx_upper(y) : y)) return 0;
    }
    return rx_call(m, k, back ? i - len : i + len);
  }
  }
  return 0;
}

typedef struct {
  rx_node *root;
  int groups;
  int unicode, fold, multiline, dot_all;
} rx_program;

static int rx_found_k(rx_m *m, rx_k *k, int j) {
  (void)m;
  k->x = j;
  return 1;
}
/* The matcher closure: f(s, start, sticky). Its capture: the program, as a pointer in a number. */
static yk rx_matcher_code(void *c, yk self, uint64_t argc, const yk *argv) {
  (void)self;
  rx_program *pg = (rx_program *)(uintptr_t)num(((yk_closure *)c)->captures[0]);
  yk sv = argc > 0 ? argv[0] : YK_UNDEFINED;
  yk_string *s = str(is_string(sv) ? sv : to_string(sv));
  int start = argc > 1 ? (int)num(argv[1]) : 0;
  int sticky = argc > 2 && yk_truthy(argv[2]);
  int ncaps = 2 * (pg->groups + 1);
  int *caps = malloc((size_t)ncaps * sizeof(int));
  rx_m m = {s->units, (int)s->len, caps, pg->unicode, pg->fold, pg->multiline, pg->dot_all, 0};
  for (int pos = start; pos <= m.n;) {
    for (int g = 0; g < ncaps; g++) caps[g] = -1;
    rx_k found = {rx_found_k, NULL, -1, 0, 0, NULL};
    if (rx_match(&m, pg->root, pos, &found, 0)) {
      caps[0] = pos, caps[1] = found.x;
      yk_array *r = new_array((uint32_t)ncaps);
      for (int g = 0; g < ncaps; g++) push(r, yk_number(caps[g]));
      free(caps);
      return BOX(T_ARRAY, r);
    }
    if (sticky) break;
    pos += m.unicode && pos < m.n && s->units[pos] >= 0xD800 && s->units[pos] <= 0xDBFF && pos + 1 < m.n &&
                   s->units[pos + 1] >= 0xDC00 && s->units[pos + 1] <= 0xDFFF
               ? 2
               : 1;
  }
  free(caps);
  return YK_NULL;
}

/* A pattern compiled: the matcher closure and the group names (an array, undefined for unnamed);
   a SyntaxError if it does not parse. */
static void rx_compile(yk pattern, yk flags, yk *matcher, yk *names) {
  yk_string *p = str(pattern), *f = str(flags);
  rx_parser ps = {0};
  ps.p = p->units, ps.len = p->len;
  int seen[128] = {0};
  for (uint32_t i = 0; i < f->len; i++) {
    uint16_t ch = f->units[i];
    if (ch >= 128 || !strchr("dgimsuy", ch) || seen[ch]) {
      yk msg = concat(str(ascii("Invalid flags supplied to RegExp constructor '")), f);
      yk_throw(make_error("SyntaxError", concat(str(msg), str(ascii("'")))));
    }
    seen[ch] = 1;
  }
  ps.unicode = seen['u'], ps.fold = seen['i'];
  rx_total = rx_total_groups(p->units, p->len);
  rx_node *root = rx_parse_alt(&ps);
  if (ps.error == NULL && ps.at < ps.len) ps.error = ps.p[ps.at] == ')' ? "Unmatched ')'" : "Unexpected character";
  for (int r = 0; r < ps.nrefs && ps.error == NULL; r++) {
    rx_node *ref = ps.named_refs[r];
    for (int g = 0; g < ps.groups && ref->index == 0; g++)
      if (ps.names[g] != NULL && ref->ref_name != NULL && strcmp(ps.names[g], ref->ref_name) == 0) ref->index = g + 1;
    if (ref->index == 0) ps.error = "Invalid named capture referenced";
  }
  if (ps.error != NULL) {
    yk m = concat(str(ascii("Invalid regular expression: /")), p);
    m = concat(str(m), str(ascii("/")));
    m = concat(str(m), f);
    m = concat(str(m), str(ascii(": ")));
    m = concat(str(m), str(ascii(ps.error)));
    yk_throw(make_error("SyntaxError", m));
  }
  if (ps.fold) rx_fold_chars(root);
  rx_prepare(root);
  rx_program *pg = calloc(1, sizeof(rx_program));
  pg->root = root, pg->groups = ps.groups;
  pg->unicode = ps.unicode, pg->fold = ps.fold, pg->multiline = seen['m'], pg->dot_all = seen['s'];
  yk cap = yk_number((double)(uintptr_t)pg);
  *matcher = yk_closure_new(rx_matcher_code, 0, 1, &cap);
  yk_array *nm = new_array((uint32_t)ps.groups);
  for (int g = 0; g < ps.groups; g++)
    push(nm, g < ps.names_cap && ps.names[g] != NULL ? yk_string_utf8(ps.names[g], strlen(ps.names[g])) : YK_UNDEFINED);
  *names = BOX(T_ARRAY, nm);
}
