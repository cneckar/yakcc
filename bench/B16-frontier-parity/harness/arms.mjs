// SPDX-License-Identifier: MIT
// B16 arms (PROTOCOL.md §3). Every arm sees the same task text; they differ in the model, the
// effort, and whether the library is in the loop.
//   scratch   one call: the model writes the whole solution
//   routed    B14's routed arm (15-line threshold): write at once if small, else search the
//             library, pick a module or none, write glue around it
//   search    B14's reuse arm: always search the library first (no route), pick a module or none,
//             write glue around it; added after phase 1, where every routed miss was a task
//             routed to write (PROTOCOL.md §3)
//   forced    always search, with no way to decline before seeing the candidates (the need
//             prompt has no NONE); added after phase 1c, where A-haiku declined on every hard
//             validation task (PROTOCOL.md §3)
//   oracle    the target module is handed over (its root source), the model writes glue only:
//             the upper bound of the reuse path, so discovery losses can be told from glue losses
import {
  extractCode,
  gluePrompt,
  isTargetEntry,
  runReuse,
  runScratch,
} from "../../B14-module-reuse/harness/lib.mjs";
import { scoreSolution } from "./score.mjs";

export const MODELS = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-2",
};

/** The arms, in report order. `phase` 1 is the cheap calibration; 2 is the frontier. */
export const ARMS = [
  { id: "S-haiku", model: "haiku", effort: "high", strategy: "scratch", phase: 1 },
  { id: "S-haiku-max", model: "haiku", effort: "max", strategy: "scratch", phase: 1 },
  { id: "R-haiku", model: "haiku", effort: "high", strategy: "routed", phase: 1 },
  { id: "A-haiku", model: "haiku", effort: "high", strategy: "search", phase: 1 },
  { id: "F-haiku", model: "haiku", effort: "high", strategy: "forced", phase: 1 },
  { id: "O-haiku", model: "haiku", effort: "high", strategy: "oracle", phase: 1 },
  { id: "S-sonnet", model: "sonnet", effort: "high", strategy: "scratch", phase: 2 },
  { id: "S-opus", model: "opus", effort: "high", strategy: "scratch", phase: 2 },
  { id: "S-fable", model: "fable", effort: "high", strategy: "scratch", phase: 2 },
];

/** Run one arm on one task. `library` is B14's moduleLibrary over B16's index. */
export async function runArm({ arm, task, client, library }) {
  const t0 = Date.now();
  let row;
  if (arm.strategy === "scratch") {
    row = await runScratch({ task, client, score: scoreSolution });
  } else if (arm.strategy === "routed") {
    row = await runReuse({
      task,
      client,
      search: library.search,
      rootSourceOf: library.rootSourceOf,
      route: true,
      score: scoreSolution,
    });
  } else if (arm.strategy === "forced") {
    row = await runReuse({
      task,
      client,
      search: library.search,
      rootSourceOf: library.rootSourceOf,
      force: true,
      score: scoreSolution,
    });
  } else if (arm.strategy === "search") {
    row = await runReuse({
      task,
      client,
      search: library.search,
      rootSourceOf: library.rootSourceOf,
      route: false,
      score: scoreSolution,
    });
  } else if (arm.strategy === "oracle") {
    const entry = library.index.entries.find((e) => isTargetEntry(task, e));
    const r = await client.complete(
      gluePrompt(task, task.lib.name, entry ? library.rootSourceOf(entry.id) : ""),
    );
    row = {
      ...scoreSolution(task, extractCode(r.text), task.lib),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      turns: 1,
      code: extractCode(r.text),
      stopReason: r.stopReason,
    };
  } else throw new Error(`unknown strategy ${arm.strategy}`);
  return { ...row, arm: arm.id, task: task.id, ms: Date.now() - t0 };
}
