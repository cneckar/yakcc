// SPDX-License-Identifier: MIT
// Offline client for harness validation. It returns each task's reference solution
// with token counts estimated from the text length. It is NOT a model and produces no
// measurement of reuse. It exists to exercise the harness end to end without a key.
// It is given each task's client view (id, spec, reference), never the held-out check.
import { clientView, extractCode } from "./lib.mjs";

export function offlineClient(tasksById) {
  // Keep only what a client may see. The held-out checks stay with the scorer.
  const views = Object.fromEntries(Object.entries(tasksById).map(([id, t]) => [id, clientView(t)]));
  return {
    async complete(prompt) {
      // The fallback arm's confirm turn: the offline client keeps nothing, so the dry run is
      // deterministic (the scripted tests cover the compose path).
      if (prompt.includes('{"use": [candidate numbers]}'))
        return { text: '{"use": []}', inputTokens: Math.ceil(prompt.length / 4), outputTokens: 4 };
      const id = matchTaskId(prompt, views);
      const task = id ? views[id] : undefined;
      const text = task ? "```ts\n" + task.reference + "\n```" : "```ts\n// no task\n```";
      return {
        text,
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(text.length / 4),
      };
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
