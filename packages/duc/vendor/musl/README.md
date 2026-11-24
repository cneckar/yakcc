# musl 1.2.5 (vendored subset)

From https://musl.libc.org/releases/musl-1.2.5.tar.gz
(sha256 `a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4`), unmodified, under
musl's license (`COPYRIGHT`). Only the files the C front end shaves, and the headers they include:

- `src/math/scalbn.c`
- `src/string/{memcpy,memset,strlen,strcmp}.c`, `src/stdlib/{qsort,qsort_nr}.c`
- their headers: `include/`, `src/include/`, `src/internal/atomic.h`, `arch/x86_64/bits/`

Two files are not musl's own sources:

- `obj/include/bits/alltypes.h` is generated as musl's build does:
  `sed -f tools/mkalltypes.sed arch/x86_64/bits/alltypes.h.in include/alltypes.h.in`.
- `yakcc/atomic_arch.h` has no architecture code, so `atomic.h` uses musl's portable C (no inline
  assembly); its two definitions, single-threaded `a_cas` and `a_cas_p`, only let `atomic.h` parse.

Parse with musl's own include order (as its Makefile):
`-std=c99 -nostdinc -ffreestanding -D_XOPEN_SOURCE=700 -Iyakcc -Iarch/x86_64 -Iarch/generic -Isrc/include -Isrc/internal -Iobj/include -Iinclude`.
