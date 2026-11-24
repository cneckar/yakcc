import { readFileSync, writeFileSync } from "node:fs";
import { Project } from "ts-morph";
import { it } from "vitest";
import { liftAtom } from "./lift.js";
import type { DucGraph } from "./types.js";
it("ts", () => {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
  const sf = project.createSourceFile(
    "typescript.js",
    readFileSync(
      "/home/user/yakcc/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js",
      "utf8",
    ),
  );
  const kinds = new Map<string, number>();
  let total = 0,
    clean = 0,
    failed = 0;
  const fails: string[] = [];
  const opaqueIn = (g: DucGraph, o: string[]): void => {
    for (const n of g.nodes) {
      if (/#[0-9a-f]{16}$/.test(n.label ?? ""))
        o.push((n.label as string).replace(/#[0-9a-f]{16}$/, ""));
      if (n.closure) opaqueIn(n.closure, o);
    }
  };
  const visit = (stmts: any[]) => {
    for (const st of stmts) {
      total++;
      const t = st.getText();
      let g;
      try {
        g = liftAtom(t);
      } catch (e) {
        failed++;
        if (fails.length < 20)
          fails.push(`${st.getStartLineNumber()} ${(e as Error).message.slice(0, 120)}`);
        continue;
      }
      const o: string[] = [];
      opaqueIn(g, o);
      if (o.length === 0) clean++;
      for (const k of new Set(o)) kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
  };
  // typescript.js is one CommonJS module; its body is a top-level var ts = {} and a wrapper: lift the
  // statements of the outermost function bodies with many statements, as the module's own.
  const top = sf.getStatements();
  const bodies = sf
    .getDescendants()
    .filter(
      (d: any) =>
        d.getKindName() === "Block" &&
        d.getParent()?.getKindName?.().includes("Function") &&
        d.getStatements().length > 500,
    );
  visit(bodies.length > 0 ? bodies.flatMap((b: any) => b.getStatements()) : top);
  writeFileSync(
    "/tmp/claude-0/-home-user-yakcc/13b2898c-9254-50d4-a3aa-7edccb49551d/scratchpad/ts-lift.txt",
    `statements ${total}, lift failures ${failed}, clean ${clean} (${((100 * clean) / total).toFixed(2)}%)\n` +
      [...kinds]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${k}`)
        .join("\n") +
      "\n\nFAILS\n" +
      fails.join("\n"),
  );
}, 7_000_000);
