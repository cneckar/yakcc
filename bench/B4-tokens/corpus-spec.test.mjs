// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/corpus-spec.test.mjs
//
// @decision DEC-BENCH-B4-NON-ENGAGEMENT-001
// @title B4 corpus-spec: non-engagement annotation test
// @status accepted
// @rationale
//   Validates that corpus-spec.json is structurally correct and that
//   debounce-with-cancel has an explicit non-engagement annotation explaining
//   why the hook produced zero reduction in Slice 1.
//   Root cause of WI-B4-DEBOUNCE-HOOK-ENGAGEMENT (#451):
//     The debounce task requires no reusable atoms — it is a novel stateful
//     higher-order function that does not decompose into yakcc registry atoms.
//     The model correctly ignored the yakccResolve tool and generated the
//     implementation directly, producing ~427 tokens on both arms (1.4% noise).
//   Resolution: explicit non-engagement annotation in corpus-spec.json.
//   Follow-up: #451 tracks adding a timer-management atom to the registry seed
//   corpus, which would give the hook a substitution target for debounce in Slice 2.
//
// Run:
//   node bench/B4-tokens/corpus-spec.test.mjs

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, "corpus-spec.json");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

console.log("=".repeat(60));
console.log("corpus-spec.json validation for B4-tokens");
console.log("=".repeat(60));

// Test 1: File exists
assert(existsSync(SPEC_PATH), "corpus-spec.json exists at bench/B4-tokens/corpus-spec.json");

if (!existsSync(SPEC_PATH)) {
  console.error("\nFATAL: corpus-spec.json missing — cannot continue.");
  process.exit(1);
}

const raw = readFileSync(SPEC_PATH, "utf8");
let spec;
try {
  spec = JSON.parse(raw);
  assert(true, "corpus-spec.json is valid JSON");
} catch (e) {
  assert(false, `corpus-spec.json is valid JSON (parse error: ${e.message})`);
  process.exit(1);
}

// Test 2: Required top-level fields
assert(typeof spec.description === "string", "spec has description field");
assert(typeof spec.schema_version === "number", "spec has schema_version field");
assert(Array.isArray(spec.tasks), "spec has tasks array");

// Test 2b: Triage completion fields (added when #442 Slice 1 triage was closed)
assert(spec.triage_status === "complete", "spec.triage_status is 'complete'");
assert(typeof spec.triage_summary === "object" && spec.triage_summary !== null, "spec.triage_summary exists");
assert(typeof spec.triage_summary.kill_verdict === "string", "triage_summary.kill_verdict is documented");
assert(typeof spec.triage_summary.csv_parser_correctness === "string", "triage_summary.csv_parser_correctness is documented");
assert(typeof spec.triage_summary.debounce_non_engagement === "string", "triage_summary.debounce_non_engagement is documented");

// Test 3: debounce-with-cancel entry exists
const debounceEntry = spec.tasks.find((t) => t.id === "debounce-with-cancel");
assert(debounceEntry !== undefined, "tasks array contains debounce-with-cancel entry");

if (!debounceEntry) {
  console.error("\nFATAL: debounce-with-cancel entry missing — cannot validate annotation.");
  process.exit(1);
}

// Test 4: Non-engagement annotation is present and correct
assert(debounceEntry.hook_engagement === "none", "debounce-with-cancel has hook_engagement: 'none'");
assert(typeof debounceEntry.non_engagement_reason === "string", "debounce-with-cancel has non_engagement_reason");
assert(debounceEntry.non_engagement_reason.length > 20, "non_engagement_reason is substantive (>20 chars)");
assert(typeof debounceEntry.follow_up_issue === "string", "debounce-with-cancel has follow_up_issue");

// Test 5: hook_engagement values for other tasks
const lruEntry = spec.tasks.find((t) => t.id === "lru-cache-with-ttl");
const csvEntry = spec.tasks.find((t) => t.id === "csv-parser-quoted");
assert(lruEntry !== undefined, "tasks array contains lru-cache-with-ttl entry");
assert(csvEntry !== undefined, "tasks array contains csv-parser-quoted entry");

// Test 6: All tasks have required annotation fields
for (const task of spec.tasks) {
  assert(typeof task.id === "string", `task ${task.id} has id field`);
  assert(typeof task.hook_engagement === "string", `task ${task.id} has hook_engagement field`);
  const validEngagement = ["none", "low", "medium", "high", "unknown"];
  assert(
    validEngagement.includes(task.hook_engagement),
    `task ${task.id} hook_engagement is valid (got: ${task.hook_engagement})`
  );
}

// Summary
console.log();
console.log("=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  process.exit(1);
}
