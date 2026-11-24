/* What musl's startup (__init_libc, __init_tp) sets up before main, for tests that run musl's
 * library without a process start: an auxiliary vector with no entries, the page size, and the
 * thread's locale (the global one). Parsed with musl's own headers. */
#include "libc.h"
#include "pthread_impl.h"

static size_t yk_auxv[2];

void yk_musl_init(void)
{
	libc.auxv = yk_auxv;
	libc.page_size = 4096;
	__pthread_self()->locale = &libc.global_locale;
}
