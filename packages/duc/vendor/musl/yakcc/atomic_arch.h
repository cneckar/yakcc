/* yakcc: an atomic_arch.h with no architecture code, so musl's src/internal/atomic.h uses its own
 * portable C definitions (a_ctz_64 by a de Bruijn table) instead of inline assembly. atomic.h
 * requires compare-and-swap (int and pointer); these single-threaded ones only let it parse: the functions shaved
 * here do not call it. The native oracle is built with the same header, so both sides run the
 * same C. Not part of musl; see packages/duc/vendor/musl/README.md. */
#define a_cas a_cas
static inline int a_cas(volatile int *p, int t, int s)
{
	int old = *p;
	if (old == t) *p = s;
	return old;
}

#define a_cas_p a_cas_p
static inline void *a_cas_p(volatile void *p, void *t, void *s)
{
	void *old = *(void *volatile *)p;
	if (old == t) *(void *volatile *)p = s;
	return old;
}
