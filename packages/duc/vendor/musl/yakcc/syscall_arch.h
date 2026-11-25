/* yakcc: the system call as a leaf (#1365). Each __syscallN calls __yk_syscall, the layer-0 leaf a
 * target implements (on x86-64 Linux, the `syscall` instruction); no inline assembly here. No vDSO:
 * clock_gettime makes the system call. The non-assembly definitions are x86-64's. Not part of musl;
 * see packages/duc/vendor/musl/README.md. */
#define __SYSCALL_LL_E(x) (x)
#define __SYSCALL_LL_O(x) (x)

long __yk_syscall(long n, long a1, long a2, long a3, long a4, long a5, long a6);

static __inline long __syscall0(long n) { return __yk_syscall(n, 0, 0, 0, 0, 0, 0); }
static __inline long __syscall1(long n, long a1) { return __yk_syscall(n, a1, 0, 0, 0, 0, 0); }
static __inline long __syscall2(long n, long a1, long a2) { return __yk_syscall(n, a1, a2, 0, 0, 0, 0); }
static __inline long __syscall3(long n, long a1, long a2, long a3) { return __yk_syscall(n, a1, a2, a3, 0, 0, 0); }
static __inline long __syscall4(long n, long a1, long a2, long a3, long a4) { return __yk_syscall(n, a1, a2, a3, a4, 0, 0); }
static __inline long __syscall5(long n, long a1, long a2, long a3, long a4, long a5) { return __yk_syscall(n, a1, a2, a3, a4, a5, 0); }
static __inline long __syscall6(long n, long a1, long a2, long a3, long a4, long a5, long a6) { return __yk_syscall(n, a1, a2, a3, a4, a5, a6); }

#define IPC_64 0
