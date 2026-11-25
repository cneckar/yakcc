/* yakcc: x86-64's reloc.h with no inline assembly (#1365). CRTJMP, which musl's __unmapself uses
 * to leave a thread's stack before unmapping it, is a call of the function on the stack it is on:
 * a shaved program has one stack, of the leaves' memory, and the function called (do_unmap) ends
 * with the exit system call. GETFUNCSYM (the dynamic linker's) is not defined. Otherwise
 * arch/x86_64/reloc.h. Not part of musl; see packages/duc/vendor/musl/README.md. */
#define LDSO_ARCH "x86_64"

#define REL_SYMBOLIC    R_X86_64_64
#define REL_OFFSET32    R_X86_64_PC32
#define REL_GOT         R_X86_64_GLOB_DAT
#define REL_PLT         R_X86_64_JUMP_SLOT
#define REL_RELATIVE    R_X86_64_RELATIVE
#define REL_COPY        R_X86_64_COPY
#define REL_DTPMOD      R_X86_64_DTPMOD64
#define REL_DTPOFF      R_X86_64_DTPOFF64
#define REL_TPOFF       R_X86_64_TPOFF64
#define REL_TLSDESC     R_X86_64_TLSDESC

#define CRTJMP(pc,sp) ((void)(sp), ((void (*)(void))(pc))())
