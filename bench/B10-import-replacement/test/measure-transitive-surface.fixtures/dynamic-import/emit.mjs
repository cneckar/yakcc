// T6 fixture: literal dynamic import traversed, non-literal NOT traversed
// dyn-pkg has 3 functions; literal import("dyn-pkg") -> traversed (3 fns counted)
// import(someVar) -> non-literal, NOT traversed
// Expected: emit(1) + dyn-pkg(3) = 4 reachable_functions
//           dynamic_literal_imports: 1, dynamic_non_literal_imports: 1
export async function emitFn() {
  const mod = await import("dyn-pkg");
  return mod;
}
export async function emitFn2(pkgName) {
  const mod = await import(pkgName);
  return mod;
}
