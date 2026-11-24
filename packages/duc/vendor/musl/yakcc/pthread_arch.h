/* yakcc: the thread pointer as a leaf (#1365): __yk_tp() is the address of this thread's control
 * block (on x86-64, %fs:0), whose first word points to itself. No inline assembly here. The
 * non-assembly definition is x86-64's. Not part of musl; see packages/duc/vendor/musl/README.md. */
uintptr_t __yk_tp(void);

static inline uintptr_t __get_tp() { return __yk_tp(); }

#define MC_PC gregs[REG_RIP]
