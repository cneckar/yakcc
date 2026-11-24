// SPDX-License-Identifier: MIT
// The model client shared by B12's generators. It uses the Anthropic SDK version that
// @yakcc/shave pins, refuses to run without ANTHROPIC_API_KEY, and reports token usage so a
// run's cost is known. Nothing else in B12 calls a model.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");

/** Dollars per million tokens (input, output), first-party API, as of 2026-11. */
export const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
// Bulk generation (descriptions, queries, picks) defaults to the cheapest current model.
// Use --model to spot-check a stronger one on a --sample of the same items; do not run a
// whole corpus on a large model by default (the first held-out run did, at ~35x the cost).
export const DEFAULT_MODEL = "claude-haiku-5-5";

/** The default spending cap per script run, in dollars (raise with --max-dollars). */
export const DEFAULT_MAX_DOLLARS = 2;

/**
 * Refuse a run whose estimated cost on `model` exceeds `maxDollars`. The estimate comes
 * from estimateCost (characters / 4 for input); a model with no price is refused.
 */
export function checkBudget(estimate, model, maxDollars = DEFAULT_MAX_DOLLARS) {
  const e = estimate[model];
  if (e === undefined) throw new Error(`no price for ${model}; add it to PRICES before running`);
  if (e.dollars > maxDollars)
    throw new Error(
      `estimated $${e.dollars} on ${model} exceeds the cap of $${maxDollars}; pass --max-dollars to raise it`,
    );
  return e;
}

/** Every k-th item, so a sample is deterministic and the same across models. */
export function evenSample(items, n) {
  if (!(n > 0) || n >= items.length) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

/** A rough cost for a planned run: tokens estimated as chars / 4. */
export function estimateCost(inputChars, outputTokens, calls) {
  const inputTokens = Math.ceil(inputChars / 4);
  return Object.fromEntries(
    Object.entries(PRICES).map(([m, [pi, po]]) => [
      m,
      {
        calls,
        inputTokens,
        outputTokens,
        dollars: +((inputTokens * pi + outputTokens * po) / 1e6).toFixed(2),
      },
    ]),
  );
}

/** The API key: ANTHROPIC_API_KEY, else CLAUDE_API_KEY. */
export function apiKeyFromEnv() {
  return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || undefined;
}

/** Map with at most `limit` calls in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A client with complete(system, user) -> { text, inputTokens, outputTokens, stopReason }. */
export async function modelClient({
  model = DEFAULT_MODEL,
  maxTokens = 4000,
  effort = "low",
} = {}) {
  const apiKey = apiKeyFromEnv();
  if (!apiKey)
    throw new Error(
      "ANTHROPIC_API_KEY is not set (nor CLAUDE_API_KEY): this step needs a key and approved spend",
    );
  const req = createRequire(join(repo, "packages/shave/package.json"));
  const { default: Anthropic } = await import(pathToFileURL(req.resolve("@anthropic-ai/sdk")).href);
  const client = new Anthropic({ apiKey, maxRetries: 6 });
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  let overhead;
  const count = async (text) =>
    (await client.messages.countTokens({ model, messages: [{ role: "user", content: text }] }))
      .input_tokens;
  return {
    usage,
    /** Tokens in a piece of text, by the model's tokenizer (message overhead removed). */
    async countTokens(text) {
      overhead ??= (await count(".")) - 1;
      return (await count(text)) - overhead;
    },
    async complete(system, user) {
      const m = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        ...(effort ? { output_config: { effort } } : {}),
      });
      usage.inputTokens += m.usage.input_tokens;
      usage.outputTokens += m.usage.output_tokens;
      usage.calls++;
      return {
        inputTokens: m.usage.input_tokens,
        outputTokens: m.usage.output_tokens,
        text: m.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(""),
        stopReason: m.stop_reason,
      };
    },
  };
}

/**
 * The JSON object a reply ends with (fenced or bare), or null. Prose before it may contain
 * braces, so the last "{" that starts a parseable object wins.
 */
export function extractJson(text) {
  const fenced = /```(?:json)?\n([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const end = body.lastIndexOf("}");
  for (
    let start = body.lastIndexOf("{", end);
    start >= 0;
    start = body.lastIndexOf("{", start - 1)
  ) {
    try {
      const v = JSON.parse(body.slice(start, end + 1));
      if (v !== null && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
    if (start === 0) break;
  }
  return null;
}

/** Replace a definition's own name with a neutral one, so a description cannot copy it. */
export function maskName(text, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return text;
  return text.replace(new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g"), "fn");
}
