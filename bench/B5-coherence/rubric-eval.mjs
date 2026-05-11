// SPDX-License-Identifier: MIT
//
// bench/B5-coherence/rubric-eval.mjs
// B5 coherence rubric evaluator — Tier-1 offline classifier + Tier-2 LLM judge
//
// @decision DEC-BENCH-B5-SLICE2-001
// @title B5 Slice 2: Tier-1 offline classifier + Tier-2 LLM-judge integration
// @status accepted
// @rationale
//   Slice 2 extends the Slice 1 offline classifier with an LLM-as-judge tier for
//   ambiguous cases. The two-tier architecture:
//
//   Tier-1 (this file): programmatic pattern-matching classifier.
//   - Reliable for: score 1 (re-emission), score 3 (opaque-hash)
//   - Unreliable for: score 2 (hallucinated), score 4 (minor-slip)
//
//   Tier-2 (llm-judge.mjs): Claude Opus 4.7 judge.
//   - Invoked ONLY for Tier-1 score-2 and score-4 results (ambiguous cases)
//   - Gated on ANTHROPIC_API_KEY — absent key produces judge_status: "skipped_no_api_key"
//   - Temperature 0, exponential backoff retry (1s → 2s)
//
//   Blind discipline:
//   - Arm letters (A/B) are randomized per run. arm-mapping.json records which
//     letter corresponds to which condition. The judge receives only arm letters,
//     never condition labels (hook-enabled/hook-disabled).
//
//   Output contract:
//   - Writes tmp/B5-coherence/slice2-scores.json
//   - Format: {
//       benchmark, slice, runAt, totalConversations,
//       judge_status: "judged" | "skipped_no_api_key",
//       corpus_hash: <sha256 from corpus-spec.json>,
//       conversations: [
//         {
//           id, category, expectedAtoms,
//           arms: {
//             "arm-A": { condition, turnScores: [{ ..., tier1_used, tier2_used }], failureModes, ... },
//             "arm-B": { ... }
//           }
//         }
//       ],
//       aggregate: {
//         hookEnabled: { mean, subsequentTurnRate, catastrophicRate, totalTurns, ..., assessment },
//         hookDisabled: { ... }
//       }
//     }
//
//   Cross-reference:
//     RUBRIC.md (authoritative scoring spec)
//     llm-judge.mjs (Tier-2 implementation)
//     judge-prompt.md (frozen judge prompt template)
//     corpus-spec.json (SHA-256 corpus fingerprint)
//     DEC-BENCH-B5-SLICE2-001 (this decision)
//     #189 (B5 parent issue)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreTranscriptWithLLMJudge } from "./llm-judge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function info(msg) { process.stdout.write(`${BOLD}INFO${RESET} ${msg}\n`); }
function pass(msg) { process.stdout.write(`${GREEN}PASS${RESET} ${msg}\n`); }
function kill(msg) { process.stdout.write(`${RED}KILL${RESET} ${msg}\n`); }
function warn(msg) { process.stdout.write(`${YELLOW}WARN${RESET} ${msg}\n`); }

// ---------------------------------------------------------------------------
// Rubric classifier — Tier-1
// ---------------------------------------------------------------------------

/**
 * Normalize text for re-emission detection: collapse whitespace, lowercase.
 * @param {string} text
 * @returns {string}
 */
function normalizeForReEmission(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Check if atom body is re-emitted verbatim (score 1 criterion).
 * Uses 50-character normalized substring matching per RUBRIC.md.
 *
 * @param {string} emission
 * @param {string} atomBody - The atom's implSource
 * @returns {boolean}
 */
function detectReEmission(emission, atomBody) {
  if (atomBody.length < 50) return false;
  const normalizedEmission = normalizeForReEmission(emission);
  const normalizedBody = normalizeForReEmission(atomBody);
  // Check any 50-char window of the body against the emission
  for (let i = 0; i + 50 <= normalizedBody.length; i += 25) {
    const chunk = normalizedBody.slice(i, i + 50);
    if (normalizedEmission.includes(chunk)) return true;
  }
  return false;
}

/**
 * Check if the emission contains a yakcc hash reference (yakcc:xxxxxxxx) or
 * an @yakcc/atoms import for a given atom name.
 *
 * @param {string} emission
 * @param {string} atomName
 * @returns {{ hasHash: boolean, hasImport: boolean }}
 */
function detectAtomReference(emission, atomName) {
  const hasHash = /yakcc:[0-9a-f]{4,}/i.test(emission);
  const hasImport = emission.includes(`@yakcc/atoms/${atomName}`) ||
                    emission.includes(`from "@yakcc/atoms/${atomName}"`);
  return { hasHash, hasImport };
}

/**
 * Check if emission uses the atom name semantically (in a call, reference, or prose).
 *
 * @param {string} emission
 * @param {string} atomName
 * @returns {boolean}
 */
function detectSemanticUsage(emission, atomName) {
  // Semantic usage: atom name appears in a call expression, import binding, or prose reference
  const callPattern = new RegExp(`${atomName}\\s*\\(`, "i");
  const importBinding = new RegExp(`\\{[^}]*${atomName}[^}]*\\}`, "i");
  const proseReference = new RegExp(`\\b${atomName}\\b`, "i");
  return callPattern.test(emission) || importBinding.test(emission) || proseReference.test(emission);
}

/**
 * Check if emission contains an opaque hash reference without semantic usage.
 * Score 3 criterion: hash present, no call/import using the atom name.
 *
 * @param {string} emission
 * @param {string} atomName
 * @returns {boolean}
 */
function detectOpaqueHash(emission, atomName) {
  const { hasHash, hasImport } = detectAtomReference(emission, atomName);
  const hasSemanticUsage = detectSemanticUsage(emission, atomName);
  return (hasHash || hasImport) && !hasSemanticUsage;
}

/**
 * Check for parameter ordering mismatch (heuristic score-4 indicator).
 * This is a weak signal — only catches the pattern "fn(b, a)" when the
 * atom has exactly 2 known parameters and the emission transposes them in prose.
 *
 * @param {string} emission
 * @param {string} atomName
 * @returns {boolean}
 */
function detectParameterMismatch(emission, atomName) {
  // Heuristic: look for "pass X first, then Y" or "takes Y, then X" patterns
  // This is intentionally weak — the LLM-judge handles precise cases
  const transposedPattern = /(pass|takes|accepts)\s+\w+\s+(first|then)\s+.*?(then|,)\s+\w+/i;
  return transposedPattern.test(emission);
}

/**
 * Score a single assistant emission turn (Tier-1 programmatic classifier).
 *
 * Returns: { score, failureMode, details }
 * failureMode: null | "opaque-hash" | "hallucinated" | "re-emission" | "context-collapse"
 *
 * @param {string} emission - The assistant's emission text
 * @param {string[]} atomNames - Expected atoms for this conversation
 * @param {object[]} atomBodies - Array of {name, implSource} for re-emission detection
 * @returns {{ score: number, failureMode: string|null, details: string }}
 */
function scoreTurnTier1(emission, atomNames, atomBodies) {
  // Score 0: catastrophic — vacuous or completely off-topic
  if (emission.trim().length < 10) {
    return { score: 0, failureMode: "context-collapse", details: "emission too short (vacuous)" };
  }

  // Check for any reference to conversation topic (at least one atom name appears)
  const hasAnyTopicSignal = atomNames.some(name => {
    const re = new RegExp(`\\b${name}\\b`, "i");
    return re.test(emission);
  }) || /import\s+\{/.test(emission) || /function\s+\w+/.test(emission);

  if (!hasAnyTopicSignal && atomNames.length > 0) {
    return { score: 0, failureMode: "context-collapse", details: "no topic signal in emission" };
  }

  // Score 1: re-emission — atom body verbatim in emission
  for (const { name, implSource } of atomBodies) {
    if (atomNames.includes(name) && detectReEmission(emission, implSource)) {
      return { score: 1, failureMode: "re-emission", details: `atom ${name} body re-emitted verbatim` };
    }
  }

  // Process each expected atom
  let worstScore = 5;
  let worstFailureMode = null;
  let worstDetails = "correct";

  for (const atomName of atomNames) {
    const { hasHash, hasImport } = detectAtomReference(emission, atomName);
    const hasSemanticUsage = detectSemanticUsage(emission, atomName);

    if (!hasHash && !hasImport && !hasSemanticUsage) {
      // Atom not referenced at all — conservative: treat as opaque
      // Note: known limitation; LLM-judge handles context-sensitivity
      if (worstScore > 3) {
        worstScore = 3;
        worstFailureMode = "opaque-hash";
        worstDetails = `atom ${atomName} not referenced in emission`;
      }
      continue;
    }

    // Score 3: opaque hash — hash/import present but no semantic usage
    if (detectOpaqueHash(emission, atomName)) {
      if (worstScore > 3) {
        worstScore = 3;
        worstFailureMode = "opaque-hash";
        worstDetails = `atom ${atomName} hash/import present but no semantic usage`;
      }
      continue;
    }

    // At this point: atom is referenced semantically (score 4 or 5)
    // Score 4: minor slip — parameter ordering mismatch (heuristic)
    if (detectParameterMismatch(emission, atomName)) {
      if (worstScore > 4) {
        worstScore = 4;
        worstFailureMode = null; // minor slips are not categorical failures
        worstDetails = `atom ${atomName} referenced with possible parameter mismatch`;
      }
      continue;
    }

    // Score 5: correct
  }

  return { score: worstScore, failureMode: worstFailureMode, details: worstDetails };
}

// ---------------------------------------------------------------------------
// Load transcript
// ---------------------------------------------------------------------------

/**
 * Load a JSONL transcript file.
 * @param {string} path
 * @returns {object[]}
 */
function loadTranscript(path) {
  if (!existsSync(path)) {
    throw new Error(`Transcript not found: ${path}`);
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`Failed to parse transcript line ${i + 1} in ${path}: ${e.message}`);
      }
    });
}

// ---------------------------------------------------------------------------
// Build atom bodies from conversations.jsonl for re-emission detection
// ---------------------------------------------------------------------------

/**
 * Build atom body records for re-emission detection.
 *
 * Mirror the synthetic registry construction from the harness:
 * run-conversation.mjs builds: `// ${atomName} implementation\nexport function ${atomName}(input: string): unknown { return input; }`
 *
 * @param {string[]} atomNames - Expected atoms for the conversation
 * @returns {{ name: string, implSource: string }[]}
 */
function buildAtomBodies(atomNames) {
  return atomNames.map(name => ({
    name,
    implSource: `// ${name} implementation\nexport function ${name}(input: string): unknown { return input; }`,
  }));
}

// ---------------------------------------------------------------------------
// Score a full transcript — Tier-1 + optional Tier-2 judge
// ---------------------------------------------------------------------------

/**
 * Score all assistant turns in a transcript using Tier-1 + optional Tier-2.
 *
 * Tier-2 is invoked for Tier-1 score-2 (hallucinated) and score-4 (minor-slip)
 * results when ANTHROPIC_API_KEY is available.
 *
 * @param {object[]} transcript - Array of turn objects from loadTranscript()
 * @param {string[]} atomNames - Expected atoms for the conversation
 * @param {{ name: string, implSource: string }[]} atomBodies - For re-emission detection
 * @param {string} armLabel - "arm_A" or "arm_B" (blind label)
 * @param {string} category - conversation category
 * @returns {Promise<{ turnScores: object[], failureModes: object, tier1Used: number, tier2Used: number }>}
 */
async function scoreTranscriptFull(transcript, atomNames, atomBodies, armLabel, category) {
  const turnScores = [];
  const failureModes = {
    "opaque-hash": 0,
    "hallucinated": 0,
    "re-emission": 0,
    "context-collapse": 0,
  };
  let tier1Used = 0;
  let tier2Used = 0;

  // Score only assistant turns beyond the first (turnIndex >= 1)
  for (const turn of transcript) {
    if (turn.role !== "assistant") continue;
    if (turn.turnIndex < 1) continue;

    const emission = turn.content;
    const tier1Result = scoreTurnTier1(emission, atomNames, atomBodies);

    let finalScore = tier1Result.score;
    let finalFailureMode = tier1Result.failureMode;
    let judgeResult = null;

    // Tier-2: invoke LLM judge for ambiguous Tier-1 cases (score 2 or 4)
    if (tier1Result.score === 2 || tier1Result.score === 4) {
      judgeResult = await scoreTranscriptWithLLMJudge({
        armLabel,
        category,
        atomNames,
        transcript,
        tier1Score: tier1Result.score,
        tier1FailureMode: tier1Result.failureMode,
        tier1Details: tier1Result.details,
        turnIndex: turn.turnIndex,
      });

      if (judgeResult.status === "judged" || judgeResult.status === "tier1_fallback") {
        // Use judge score if available (even fallback tracks the attempt)
        if (judgeResult.status === "judged") {
          finalScore = judgeResult.score;
          finalFailureMode = judgeResult.failureMode;
          tier2Used++;
        } else {
          // tier1_fallback: keep tier1 score
          tier1Used++;
        }
      } else {
        // skipped_no_api_key or other non-judge status
        tier1Used++;
      }
    } else {
      tier1Used++;
    }

    if (finalFailureMode !== null) {
      failureModes[finalFailureMode] = (failureModes[finalFailureMode] || 0) + 1;
    }

    turnScores.push({
      turnIndex: turn.turnIndex,
      condition: turn.condition,
      score: finalScore,
      failureMode: finalFailureMode,
      details: tier1Result.details,
      tier1_used: judgeResult === null || judgeResult.status !== "judged",
      tier2_used: judgeResult !== null && judgeResult.status === "judged",
      substitutionApplied: turn.substitutionApplied ?? false,
      judgeResult: judgeResult ?? null,
    });
  }

  return { turnScores, failureModes, tier1Used, tier2Used };
}

// ---------------------------------------------------------------------------
// Aggregate metrics
// ---------------------------------------------------------------------------

/**
 * Compute aggregate metrics from a list of scored turns.
 *
 * @param {{ score: number, failureMode: string|null }[]} turns
 * @returns {object}
 */
function computeAggregates(turns) {
  if (turns.length === 0) {
    return {
      mean: null,
      subsequentTurnRate: null,
      catastrophicRate: null,
      totalTurns: 0,
      failureModeCounts: {},
    };
  }

  const totalTurns = turns.length;
  const meanScore = turns.reduce((s, t) => s + t.score, 0) / totalTurns;
  const coherentTurns = turns.filter(t => t.score >= 4).length;
  const catastrophicTurns = turns.filter(t => t.score <= 1).length;

  const failureModeCounts = {};
  for (const turn of turns) {
    if (turn.failureMode !== null) {
      failureModeCounts[turn.failureMode] = (failureModeCounts[turn.failureMode] || 0) + 1;
    }
  }

  return {
    mean: Math.round(meanScore * 1000) / 1000,
    subsequentTurnRate: Math.round((coherentTurns / totalTurns) * 1000) / 1000,
    catastrophicRate: Math.round((catastrophicTurns / totalTurns) * 1000) / 1000,
    totalTurns,
    coherentTurns,
    catastrophicTurns,
    failureModeCounts,
  };
}

// ---------------------------------------------------------------------------
// Pass/KILL assessment
// ---------------------------------------------------------------------------

/**
 * Assess pass/KILL against B5 bars from #189.
 *
 * @param {{ mean: number, subsequentTurnRate: number, catastrophicRate: number }} agg
 * @returns {{ pass: boolean, kill: boolean, reasons: string[] }}
 */
function assessPassKill(agg) {
  if (agg.mean === null) {
    return { pass: false, kill: false, reasons: ["no scoreable turns"] };
  }

  const reasons = [];
  let kill = false;
  let pass = true;

  // KILL conditions (either triggers KILL)
  if (agg.mean < 2.5) {
    kill = true;
    reasons.push(`KILL: mean coherence ${agg.mean} < 2.5`);
  }
  if (agg.catastrophicRate > 0.15) {
    kill = true;
    reasons.push(`KILL: catastrophic rate ${(agg.catastrophicRate * 100).toFixed(1)}% > 15%`);
  }

  // Pass conditions (all must hold)
  if (agg.mean < 4.0) {
    pass = false;
    reasons.push(`BELOW-BAR: mean coherence ${agg.mean} < 4.0`);
  }
  if (agg.subsequentTurnRate < 0.90) {
    pass = false;
    reasons.push(`BELOW-BAR: subsequent-turn coherence ${(agg.subsequentTurnRate * 100).toFixed(1)}% < 90%`);
  }
  if (agg.catastrophicRate > 0.05) {
    pass = false;
    reasons.push(`BELOW-BAR: catastrophic rate ${(agg.catastrophicRate * 100).toFixed(1)}% > 5%`);
  }

  if (kill) pass = false;

  if (reasons.length === 0) {
    reasons.push("all pass bars met");
  }

  return { pass, kill, reasons };
}

// ---------------------------------------------------------------------------
// Compute corpus SHA-256
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 of a file's raw bytes.
 * @param {string} filePath
 * @returns {string} hex digest
 */
function computeFileSha256(filePath) {
  const bytes = readFileSync(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Resolve paths
  const repoRoot = (() => {
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, "packages/hooks-base/dist/index.js"))) return dir;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
    return resolve(__dirname, "../../..");
  })();

  const transcriptDir = join(repoRoot, "tmp/B5-coherence/transcripts");
  const scoreDir = join(repoRoot, "tmp/B5-coherence");
  const armMappingPath = join(scoreDir, "arm-mapping.json");
  const conversationsPath = join(__dirname, "conversations.jsonl");
  const scoresOutputPath = join(scoreDir, "slice2-scores.json");

  if (!existsSync(armMappingPath)) {
    process.stderr.write(`ERROR: arm-mapping.json not found. Run the harness first.\n  Expected: ${armMappingPath}\n`);
    process.exit(1);
  }

  if (!existsSync(conversationsPath)) {
    process.stderr.write(`ERROR: conversations.jsonl not found.\n  Expected: ${conversationsPath}\n`);
    process.exit(1);
  }

  // Determine judge status up front
  const judgeEnabled = !!process.env.ANTHROPIC_API_KEY;
  const judgeStatus = judgeEnabled ? "judged" : "skipped_no_api_key";

  if (!judgeEnabled) {
    warn("ANTHROPIC_API_KEY not set — Tier-2 LLM judge will be skipped. Tier-1 scores only.");
  } else {
    info("ANTHROPIC_API_KEY present — Tier-2 LLM judge enabled for score-2/4 cases.");
  }

  // Compute corpus SHA-256
  const corpusHash = computeFileSha256(conversationsPath);

  // Load arm mapping and conversations
  const armMapping = JSON.parse(readFileSync(armMappingPath, "utf8"));
  const conversations = readFileSync(conversationsPath, "utf8")
    .trim()
    .split("\n")
    .map(l => JSON.parse(l));

  info(`Scoring ${conversations.length} conversations (slice2, N=50)...`);

  const conversationResults = [];
  const allHookEnabledTurns = [];
  const allHookDisabledTurns = [];

  for (const conv of conversations) {
    const mapping = armMapping[conv.id];
    if (!mapping) {
      warn(`No arm mapping for conversation ${conv.id} — skipping`);
      continue;
    }

    const atomBodies = buildAtomBodies(conv.expected_atoms_referenced);
    const convResult = {
      id: conv.id,
      category: conv.category,
      expectedAtoms: conv.expected_atoms_referenced,
      arms: {},
    };

    for (const armLetter of ["arm-A", "arm-B"]) {
      const condition = mapping[armLetter];
      // Blind label: "arm_A" or "arm_B" (underscores, for judge prompt consistency)
      const armLabel = armLetter.replace("-", "_");
      const transcriptPath = join(transcriptDir, `${conv.id}-${armLetter}.jsonl`);

      if (!existsSync(transcriptPath)) {
        warn(`Transcript not found for ${conv.id} ${armLetter}: ${transcriptPath}`);
        continue;
      }

      const transcript = loadTranscript(transcriptPath);
      const { turnScores, failureModes, tier1Used, tier2Used } = await scoreTranscriptFull(
        transcript,
        conv.expected_atoms_referenced,
        atomBodies,
        armLabel,
        conv.category,
      );

      const aggregates = computeAggregates(turnScores);
      convResult.arms[armLetter] = {
        condition,
        turnScores,
        failureModes,
        tier1_used: tier1Used,
        tier2_used: tier2Used,
        ...aggregates,
      };

      // Collect for overall aggregates
      if (condition === "hook-enabled") {
        allHookEnabledTurns.push(...turnScores);
      } else {
        allHookDisabledTurns.push(...turnScores);
      }
    }

    conversationResults.push(convResult);
    info(`  ${conv.id}: scored`);
  }

  // Compute per-arm aggregates
  const hookEnabledAgg = computeAggregates(allHookEnabledTurns);
  const hookDisabledAgg = computeAggregates(allHookDisabledTurns);

  // Pass/KILL assessment
  const hookEnabledAssessment = assessPassKill(hookEnabledAgg);
  const hookDisabledAssessment = assessPassKill(hookDisabledAgg);

  // Build output — slice2-scores.json schema
  const output = {
    benchmark: "B5-coherence",
    slice: "slice2",
    runAt: new Date().toISOString(),
    totalConversations: conversations.length,
    judge_status: judgeStatus,
    corpus_hash: corpusHash,
    conversations: conversationResults,
    aggregate: {
      hookEnabled: {
        ...hookEnabledAgg,
        assessment: hookEnabledAssessment,
      },
      hookDisabled: {
        ...hookDisabledAgg,
        assessment: hookDisabledAssessment,
      },
    },
    notes: [
      "Slice 2: N=50 corpus (5 categories x 10 seeds each)",
      judgeEnabled
        ? "Tier-2 LLM judge (claude-opus-4-7) applied to score-2 and score-4 Tier-1 cases"
        : "Tier-2 LLM judge skipped (ANTHROPIC_API_KEY not set) — Tier-1 programmatic scores only",
      "Tier-1: offline programmatic classifier (reliable for score 1, 3; unreliable for 2, 4)",
      "Blind discipline: arm letters randomized per run; judge received only arm_A/arm_B labels",
      "platform: " + process.platform,
      "node: " + process.version,
    ],
  };

  mkdirSync(scoreDir, { recursive: true });
  writeFileSync(scoresOutputPath, JSON.stringify(output, null, 2), "utf8");

  // Print summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${BOLD}B5 COHERENCE — SLICE 2 RESULTS${RESET}`);
  console.log(`${"=".repeat(60)}`);
  info(`Judge status: ${judgeStatus}`);
  info(`Corpus hash: ${corpusHash}`);

  console.log(`\n${BOLD}Hook-ENABLED arm:${RESET}`);
  info(`  Mean coherence: ${hookEnabledAgg.mean ?? "N/A"} (pass bar: >= 4.0)`);
  info(`  Subsequent-turn rate: ${hookEnabledAgg.subsequentTurnRate !== null ? (hookEnabledAgg.subsequentTurnRate * 100).toFixed(1) + "%" : "N/A"} (pass bar: >= 90%)`);
  info(`  Catastrophic rate: ${hookEnabledAgg.catastrophicRate !== null ? (hookEnabledAgg.catastrophicRate * 100).toFixed(1) + "%" : "N/A"} (pass bar: <= 5%; KILL: > 15%)`);
  info(`  Total turns scored: ${hookEnabledAgg.totalTurns}`);
  info(`  Failure modes: ${JSON.stringify(hookEnabledAgg.failureModeCounts)}`);
  if (hookEnabledAssessment.kill) {
    kill(`  KILL CRITERION MET`);
  } else if (hookEnabledAssessment.pass) {
    pass(`  PASS -- all bars met`);
  } else {
    warn(`  BELOW-BAR (not KILL): ${hookEnabledAssessment.reasons.join("; ")}`);
  }

  console.log(`\n${BOLD}Hook-DISABLED arm (baseline):${RESET}`);
  info(`  Mean coherence: ${hookDisabledAgg.mean ?? "N/A"}`);
  info(`  Subsequent-turn rate: ${hookDisabledAgg.subsequentTurnRate !== null ? (hookDisabledAgg.subsequentTurnRate * 100).toFixed(1) + "%" : "N/A"}`);
  info(`  Total turns scored: ${hookDisabledAgg.totalTurns}`);
  if (hookDisabledAssessment.pass) {
    pass(`  Baseline arm PASS`);
  } else {
    warn(`  Baseline arm below-bar (expected for Slice 2 offline sim): ${hookDisabledAssessment.reasons.join("; ")}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  info(`Scores written to: ${scoresOutputPath}`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
