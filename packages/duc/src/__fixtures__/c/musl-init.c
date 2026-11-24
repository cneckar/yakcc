/* What musl's startup (__init_libc) sets up before main, for tests that run musl's library
 * without a process start: an auxiliary vector with no entries, and the page size. Parsed with
 * musl's own headers. */
#include "libc.h"

static size_t yk_auxv[2];

void yk_musl_init(void)
{
	libc.auxv = yk_auxv;
	libc.page_size = 4096;
}
