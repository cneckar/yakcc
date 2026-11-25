# musl 1.2.5 (vendored)

From https://musl.libc.org/releases/musl-1.2.5.tar.gz
(sha256 `a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4`), unmodified, under
musl's license (`COPYRIGHT`), for the C front end to shave (#1365):

- `src/`, `include/`: all of musl's sources and public headers.
- `arch/x86_64/`, `arch/generic/`: the architecture headers of the first target.
- `tools/mkalltypes.sed`: the script that generates `bits/alltypes.h`.

Not vendored: the build system, `crt/`, `ldso/`, `compat/`, other architectures (added with their
targets).

These files are not musl's own sources:

- `obj/include/bits/alltypes.h` and `obj/include/bits/syscall.h` are generated as musl's build does:
  `sed -f tools/mkalltypes.sed arch/x86_64/bits/alltypes.h.in include/alltypes.h.in`, and
  `arch/x86_64/bits/syscall.h.in` followed by its lines with `__NR_` renamed `SYS_`.
- `yakcc/syscall_arch.h`: each `__syscallN` calls `__yk_syscall`, the system-call leaf (no
  assembly, no vDSO). `yakcc/pthread_arch.h`: the thread pointer is a leaf, `__yk_tp()`.
  `yakcc/bits/float.h`: a 64-bit `long double` (musl's arm description), for units parsed with
  clang's `-mlong-double-64`, as printf and strtod are.
- `yakcc/atomic_arch.h` has no architecture code, so `src/internal/atomic.h` uses musl's portable
  C (no inline assembly); its two definitions, single-threaded `a_cas` and `a_cas_p`, only let
  `atomic.h` parse. It is found before `arch/x86_64/atomic_arch.h`.

Parse with musl's own include order (as its Makefile), the yakcc header first:
`-std=c99 -nostdinc -ffreestanding -D_XOPEN_SOURCE=700 -Iyakcc -Iarch/x86_64 -Iarch/generic -Isrc/include -Isrc/internal -Iobj/include -Iinclude`.
