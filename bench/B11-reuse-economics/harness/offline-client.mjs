// SPDX-License-Identifier: MIT
// Offline client for harness validation. It returns each task's reference solution
// with token counts estimated from the text length. It is NOT a model and produces no
// measurement of reuse. It exists to exercise the harness end to end without a key.
import { extractCode } from "./lib.mjs";

export function offlineClient(tasksById) {
  return {
    async complete(prompt) {
      const id = matchTaskId(prompt, tasksById);
      const task = id ? tasksById[id] : undefined;
      const text = task ? "```ts\n" + task.reference + "\n```" : "```ts\n// no task\n```";
      return { text, inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4) };
    },
  };
}

function matchTaskId(prompt, tasksById) {
  for (const [id, task] of Object.entries(tasksById)) {
    if (prompt.includes(task.spec)) return id;
  }
  return undefined;
}

export { extractCode };
