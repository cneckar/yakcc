// SPDX-License-Identifier: Apache-2.0
// Export lists (#1276): `export { a, b }` computes nothing; the names it exports are observed.
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { declaredNamesOf, liftAtom } from "./lift.js";

const id = (src: string): string => graphIdentity(liftAtom(src));

describe("export lists (#1276)", () => {
  it("an export list is not opaque, and observes what it exports", () => {
    const g = liftAtom("const a = 1; const b = 2; export { a, b };");
    expect(g.nodes.some((n) => n.label?.startsWith("ExportDeclaration#"))).toBe(false);
    expect(declaredNamesOf(g)).toEqual(["a", "b"]);
  });

  it("an export list is the same as exporting each declaration", () => {
    expect(id("const a = 1; export { a };")).toBe(id("export const a = 1;"));
  });

  it("export default observes the value it exports", () => {
    const g = liftAtom("const a = 1; export default a;");
    expect(g.nodes.some((n) => (n.label ?? "").startsWith("ExportAssignment#"))).toBe(false);
    // `default` is a declared name of the module, with the others (#1292).
    expect(declaredNamesOf(g)).toEqual(["default", "a"]);
    expect(id("export default 2;")).not.toBe(id("export default 3;"));
  });

  it("exporting other names is another graph, a fragment's free names and imports included", () => {
    expect(id("export { parse };")).not.toBe(id("export { transform };"));
    expect(id('import { x } from "./m"; export { x };')).not.toBe(
      id('import { y } from "./m"; export { y };'),
    );
  });
});
