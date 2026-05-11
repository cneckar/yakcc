// SPDX-License-Identifier: MIT
//
// bench/B5-coherence/harness/run-conversation.mjs
// B5 multi-turn coherence benchmark harness — Slice 1 (offline simulation)
//
// @decision DEC-BENCH-B5-SLICE1-001
// @title B5 Slice 1: offline simulation harness — assistant_emission_target substitution
// @status accepted
// @rationale
//   Slice 1 does NOT call a real LLM API (constraint: no external API in Slice 1).
//   Instead, each conversation seed carries an `assistant_emission_target` field
//   for each assistant turn. The harness uses this as the simulated assistant emission.
//
//   Two arms are run per conversation:
//
//   ARM A — hook-disabled:
//     The assistant_emission_target is recorded verbatim. No substitution is
//     applied. This simulates the baseline where the hook is off and the LLM sees
//     its own raw emissions. Expected coherence: ~5 (no substitution to fail).
//
//   ARM B — hook-enabled:
//     The assistant_emission_target is passed through
//     executeRegistryQueryWithSubstitution() from @yakcc/hooks-base against a
//     synthetic in-memory registry pre-seeded with the conversation's
//     expected_atoms_referenced entries. The synthetic registry uses deterministic
//     mock embeddings (same approach as hooks-base tests) to return high-confidence
//     matches for the known atoms. This simulates the hook intercepting the LLM's
//     emission and substituting the atom reference.
//
//   Why offline simulation is sufficient for Slice 1:
//     The rubric classifier tests structural properties (hash present? body re-emitted?
//     semantics hallucinated?). These properties are deterministic given the
//     assistant_emission_target values. Real LLM variance (Slice 2) tests whether the
//     classifier's rubric is well-calibrated; offline simulation tests whether the
//     harness infrastructure and classifier logic are correct.
//
//   D-HOOK-6 embedded library call:
//     The harness imports @yakcc/hooks-base directly (ESM import), not via subprocess
//     or RPC. This is the D-HOOK-6 embedded library call pattern as required.
//
//   Blind-eval arm assignment:
//     Arm letters (A/B) are randomized per run to implement the blind-eval discipline
//     from RUBRIC.md. The arm-mapping.json file records which letter corresponds to
//     which condition. The rubric evaluator reads only transcripts; the verdict script
//     reads arm-mapping.json only after scoring is complete.
//
//   Cross-reference:
//     RUBRIC.md (scoring rules, blind-eval discipline)
//     DEC-BENCH-B5-SLICE1-001 (this decision)
//     #189 (B5 parent issue)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Resolve repo root (same pattern as B6-airgap/run.mjs)
// ---------------------------------------------------------------------------

function resolveRepoRoot() {
  if (process.env.YAKCC_REPO_ROOT) return process.env.YAKCC_REPO_ROOT;
  // Walk up from harness/ looking for packages/hooks-base/dist/index.js
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "packages/hooks-base/dist/index.js"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: git --git-common-dir
  try {
    const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: __dirname, encoding: "utf8" });
    if (r.status === 0) {
      const absGitDir = resolve(__dirname, r.stdout.trim());
      const root = resolve(absGitDir, "..");
      if (existsSync(join(root, "packages/hooks-base/dist/index.js"))) return root;
    }
  } catch (_) {}
  return resolve(__dirname, "../../..");
}

const REPO_ROOT = resolveRepoRoot();

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function info(msg) { process.stdout.write(`${BOLD}INFO${RESET} ${msg}\n`); }
function ok(msg)   { process.stdout.write(`${GREEN}OK  ${RESET} ${msg}\n`); }
function warn(msg) { process.stdout.write(`${YELLOW}WARN${RESET} ${msg}\n`); }

// ---------------------------------------------------------------------------
// Load @yakcc/hooks-base + @yakcc/registry (D-HOOK-6 embedded library call)
// ---------------------------------------------------------------------------

async function loadHooksBase() {
  const hooksBasePath = pathToFileURL(join(REPO_ROOT, "packages/hooks-base/dist/index.js")).href;
  return await import(hooksBasePath);
}

async function loadRegistry() {
  // openRegistry is in @yakcc/registry
  const registryPkgPath = join(REPO_ROOT, "packages/registry");
  // Try dist first; the test environment builds registry
  const distPath = join(registryPkgPath, "dist/index.js");
  if (!existsSync(distPath)) {
    throw new Error(`@yakcc/registry not built. Run 'pnpm build' first. Missing: ${distPath}`);
  }
  return await import(pathToFileURL(distPath).href);
}

async function loadContracts() {
  const contractsDistPath = join(REPO_ROOT, "packages/contracts/dist/index.js");
  if (!existsSync(contractsDistPath)) {
    throw new Error(`@yakcc/contracts not built. Run 'pnpm build' first. Missing: ${contractsDistPath}`);
  }
  return await import(pathToFileURL(contractsDistPath).href);
}

// ---------------------------------------------------------------------------
// Deterministic mock embedding provider (same as hooks-base tests)
// ---------------------------------------------------------------------------

function makeMockEmbeddingProvider() {
  return {
    dimension: 384,
    modelId: "mock/b5-harness",
    async embed(text) {
      const vec = new Float32Array(384);
      const tlen = Math.max(1, text.length);
      for (let i = 0; i < 384; i++) {
        const charIdx = (i * 7 + 3) % tlen;
        const charCode = text.charCodeAt(charIdx) / 128;
        vec[i] = charCode * Math.sin((i + 1) * 0.05) + (i % 10) * 0.001;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        vec[i] = vec[i] * scale;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Build a synthetic registry seeded with a conversation's expected atoms
// ---------------------------------------------------------------------------

async function buildSyntheticRegistry(atomNames, registryModule, contractsModule) {
  const { openRegistry } = registryModule;
  const { blockMerkleRoot, canonicalize, specHash: deriveSpecHash, canonicalAstHash: deriveCanonicalAstHash } = contractsModule;

  const registry = await openRegistry(":memory:", { embeddings: makeMockEmbeddingProvider() });

  for (const atomName of atomNames) {
    // Build a minimal SpecYak for this atom
    const spec = {
      name: atomName,
      inputs: [{ name: "input", type: "string" }],
      outputs: [{ name: "result", type: "unknown" }],
      preconditions: [],
      postconditions: [],
      invariants: [],
      effects: [],
      level: "L0",
      behavior: `${atomName} — registered atom for B5 coherence benchmark`,
      guarantees: [{ description: `${atomName} never throws` }],
      errorConditions: [],
      nonFunctional: { purity: "pure", threadSafety: "safe" },
      propertyTests: [],
    };

    const implSource = `// ${atomName} implementation\nexport function ${atomName}(input: string): unknown { return input; }`;
    const manifest = { artifacts: [] };
    const artifacts = new Map();

    const root = blockMerkleRoot({ spec, implSource, manifest, artifacts });
    const sh = deriveSpecHash(spec);
    const canonicalBytes = canonicalize(spec);
    const astHash = deriveCanonicalAstHash(implSource);

    const row = {
      blockMerkleRoot: root,
      specHash: sh,
      specCanonicalBytes: canonicalBytes,
      implSource,
      proofManifestJson: JSON.stringify(manifest),
      level: "L0",
      createdAt: Date.now(),
      canonicalAstHash: astHash,
      artifacts,
    };

    await registry.storeBlock(row);
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Simulate one arm of a conversation
// ---------------------------------------------------------------------------

/**
 * Simulate one arm of a conversation.
 *
 * hook-disabled arm: record assistant_emission_target verbatim.
 * hook-enabled arm: pass assistant_emission_target through executeRegistryQueryWithSubstitution.
 *
 * @param {object} conv - Parsed conversation seed object
 * @param {"hook-disabled"|"hook-enabled"} condition - Which arm
 * @param {object} hooksBase - Loaded @yakcc/hooks-base module
 * @param {object} registryModule - Loaded @yakcc/registry module
 * @param {object} contractsModule - Loaded @yakcc/contracts module
 * @returns {Promise<object[]>} Array of transcript turn objects
 */
async function simulateArm(conv, condition, hooksBase, registryModule, contractsModule) {
  const { executeRegistryQueryWithSubstitution, DEFAULT_REGISTRY_HIT_THRESHOLD } = hooksBase;

  // Build a fresh registry per arm so hook-disabled vs hook-enabled are independent
  let registry = null;
  if (condition === "hook-enabled") {
    registry = await buildSyntheticRegistry(
      conv.expected_atoms_referenced,
      registryModule,
      contractsModule,
    );
  }

  const transcript = [];

  for (let i = 0; i < conv.turns.length; i++) {
    const turn = conv.turns[i];

    if (turn.role === "user") {
      transcript.push({ role: "user", content: turn.content, turnIndex: i });
      continue;
    }

    if (turn.role === "assistant_emission_target") {
      const emissionTarget = turn.content;
      let recordedContent = emissionTarget;
      let substitutionApplied = false;
      let substitutionResult = null;

      if (condition === "hook-enabled" && registry !== null) {
        // Build EmissionContext from conversation context (prior user turn)
        // Find the most recent user turn for the intent
        let intent = conv.id;
        for (let j = i - 1; j >= 0; j--) {
          if (conv.turns[j].role === "user") {
            intent = conv.turns[j].content;
            break;
          }
        }

        const ctx = { intent };

        try {
          const result = await executeRegistryQueryWithSubstitution(
            registry,
            ctx,
            emissionTarget,
            "Write",
            {
              threshold: DEFAULT_REGISTRY_HIT_THRESHOLD,
              sessionId: `b5-bench-${conv.id}`,
              // Suppress telemetry disk writes in bench environment
              telemetryDir: null,
            },
          );

          if (result.substituted) {
            recordedContent = result.substitutedCode;
            substitutionApplied = true;
            substitutionResult = { atomHash: result.atomHash };
          }
        } catch (err) {
          warn(`Hook error on ${conv.id} turn ${i}: ${err.message}`);
          // Fall through: use original emission target
        }
      }

      transcript.push({
        role: "assistant",
        content: recordedContent,
        originalEmission: emissionTarget,
        turnIndex: i,
        condition,
        substitutionApplied,
        substitutionResult,
      });
    }
  }

  if (registry !== null) {
    try { await registry.close(); } catch (_) {}
  }

  return transcript;
}

// ---------------------------------------------------------------------------
// Main: read conversations.jsonl and run both arms
// ---------------------------------------------------------------------------

async function main() {
  // Verify hooks-base is built
  const hooksBaseDist = join(REPO_ROOT, "packages/hooks-base/dist/index.js");
  if (!existsSync(hooksBaseDist)) {
    process.stderr.write(`ERROR: @yakcc/hooks-base not built. Run 'pnpm build' first.\n  Missing: ${hooksBaseDist}\n`);
    process.exit(1);
  }

  // Load modules (D-HOOK-6: embedded library call, not subprocess)
  info("Loading @yakcc/hooks-base, @yakcc/registry, @yakcc/contracts...");
  const [hooksBase, registryModule, contractsModule] = await Promise.all([
    loadHooksBase(),
    loadRegistry(),
    loadContracts(),
  ]);
  info("Modules loaded.");

  // Output directories
  const transcriptDir = join(REPO_ROOT, "tmp/B5-coherence/transcripts");
  const scoreDir = join(REPO_ROOT, "tmp/B5-coherence");
  mkdirSync(transcriptDir, { recursive: true });
  mkdirSync(scoreDir, { recursive: true });

  // Read conversations.jsonl
  const conversationsPath = join(__dirname, "../conversations.jsonl");
  const convLines = readFileSync(conversationsPath, "utf8").trim().split("\n");
  const conversations = convLines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      process.stderr.write(`ERROR: Failed to parse conversations.jsonl line ${idx + 1}: ${e.message}\n`);
      process.exit(1);
    }
  });

  info(`Loaded ${conversations.length} conversations from conversations.jsonl`);

  // Randomize arm assignment for blind-eval discipline
  // Each conversation gets a random coin flip: heads = A→hook-disabled / B→hook-enabled
  //                                             tails = A→hook-enabled  / B→hook-disabled
  const armMapping = {};

  const allTranscriptPaths = [];

  for (const conv of conversations) {
    info(`\nRunning conversation: ${conv.id} (${conv.category})`);

    const coinFlip = Math.random() < 0.5;
    const armACondition = coinFlip ? "hook-disabled" : "hook-enabled";
    const armBCondition = coinFlip ? "hook-enabled" : "hook-disabled";

    armMapping[conv.id] = {
      "arm-A": armACondition,
      "arm-B": armBCondition,
    };

    // Run both arms
    const armATranscript = await simulateArm(conv, armACondition, hooksBase, registryModule, contractsModule);
    const armBTranscript = await simulateArm(conv, armBCondition, hooksBase, registryModule, contractsModule);

    // Write transcripts
    const armAPath = join(transcriptDir, `${conv.id}-arm-A.jsonl`);
    const armBPath = join(transcriptDir, `${conv.id}-arm-B.jsonl`);

    writeFileSync(
      armAPath,
      armATranscript.map(t => JSON.stringify(t)).join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      armBPath,
      armBTranscript.map(t => JSON.stringify(t)).join("\n") + "\n",
      "utf8",
    );

    ok(`  Written: ${armAPath}`);
    ok(`  Written: ${armBPath}`);
    allTranscriptPaths.push(armAPath, armBPath);
  }

  // Write arm mapping AFTER all transcripts (blind-eval: evaluator reads transcripts first)
  const armMappingPath = join(scoreDir, "arm-mapping.json");
  writeFileSync(armMappingPath, JSON.stringify(armMapping, null, 2), "utf8");
  ok(`\nArm mapping written to: ${armMappingPath}`);
  info("Harness complete. Run rubric-eval.mjs next.");
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
