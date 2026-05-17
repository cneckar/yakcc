# B4-tokens-v3 — Two-Phase Hypothesis Matrix

> **Tracking:** Issue [#644](https://github.com/cneckar/yakcc/issues/644) (WI-B4-V3-HYPOTHESIS-MATRIX)
>
> **Supersedes:** B4-tokens original single-pass matrix (corrects the experimental design per #643/#188 findings)

## The Hypothesis

> *"The hypothesis is that once the atoms for a complex task are in the corpus they will be discovered by even a cheap model and that subsequently a cheaper model will achieve the same quality on a complex task that would have otherwise required an expensive model."*
>
> — Operator framing, 2026-05-17

## Why the original B4 design missed

The 2026-05-14 B4 run showed Haiku -9.9%, Sonnet -21.1%, Opus -6.0%, killer-cell 0/8. Two root failures:

1. **No corpus**: atoms were never in the registry for the 8 tasks → substitution never fired
2. **Task complexity**: all 8 tasks were simple enough that Haiku unhooked succeeded → no quality-delta to measure even if atoms had been present

B4-v3 fixes both axes: a **two-phase design** with **complex tasks** where Haiku genuinely fails unhooked.

## The Two-Phase Design

### Phase 1 — Corpus Build (Opus, empty registry)

- Driver: Opus (locked)
- Corpus: empty (no atoms pre-seeded)
- Opus solves each task cold; atoms extracted into registry via #368 flywheel
- Records: `C_p1` (cost), `Q_p1` (oracle pass/fail), tokens, turns

This is the **investment phase**. The amortization story rests on this baseline.

### Phase 2 — Corpus Exploit (6 cells A–F, registry pre-seeded)

After Phase 1, the registry contains Opus-quality atoms. Phase 2 runs:

| Cell | Driver | Hook | Expected | Key comparison |
|------|--------|------|----------|----------------|
| **A** | Opus | unhooked | Q_high, C_opus_miss | baseline |
| **B** | Opus | hooked | Q_high, C_opus_hit ≈ A + query overhead | A — quality parity |
| **C** | Sonnet | unhooked | Q_mid/high, C_sonnet_miss | mid-quality baseline |
| **D** | Sonnet | hooked | Q_high (= A), C_sonnet_hit | A, B — quality lift + cheaper |
| **E** | Haiku | unhooked | **Q_low or many turns** | A — **the killer baseline** |
| **F** | Haiku | hooked | Q_high (= A), C_haiku_hit | A, E — **the killer cell** |

N=3 reruns per cell per task. 5 tasks × 6 cells × N=3 = **90 runs** per Phase 2 execution.

## Headline Comparisons

1. **A vs F** — equal quality, 10×–50× lower cost → hypothesis holds
2. **E vs F** — E fails oracle, F passes → quality-lift moment (the evidence)
3. **B/D/F** — cost reduction at constant quality across driver tiers

## Task Suite

| Task | Domain | Haiku failure mode |
|------|--------|--------------------|
| `json5-parser` | Parser combinator | Drops ≥3 JSON5 features (reserved-word keys, hex literals, line continuation) |
| `pkce-code-verifier` | Security protocol | base64 instead of base64url, omits timingSafeEqual, fails RFC 7636 test vector |
| `two-phase-commit` | Distributed FSM | Breaks idempotency, fails to abort YES-voters on any-NO |
| `kahan-running-stats` | Numerical precision | Population variance (n) instead of sample variance (n-1) |
| `token-bucket-rate-limiter` | Stateful time FSM | Omits tryConsume(0) contract, skips capacity cap on refill, wrong error types |

## Running

```sh
# Install dependencies (bench-local, not workspace)
pnpm --dir bench/B4-tokens-v3 install

# Run oracle tests against reference implementations (no API key needed)
pnpm --dir bench/B4-tokens-v3 test:oracles

# Phase 1 dry run (no API calls)
node bench/B4-tokens-v3/harness/phase1.mjs --dry-run

# Phase 2 dry run
node bench/B4-tokens-v3/harness/phase2.mjs --dry-run

# Real runs require ANTHROPIC_API_KEY (see $75 budget cap)
ANTHROPIC_API_KEY=... node bench/B4-tokens-v3/harness/phase1.mjs
ANTHROPIC_API_KEY=... node bench/B4-tokens-v3/harness/phase2.mjs
```

## Budget

$75 USD total cap (`DEC-V0-B4-SLICE2-COST-CEILING-004` inherited). Phase 1 ≈ $5–15; Phase 2 ≈ $40–60.

## Hypothesis Validation Criteria

Validated iff across ≥50% of tasks:
- E fails oracle OR takes ≥5× turns of A
- F passes oracle
- C_F / C_A ≤ 0.2
- Q_F == Q_A

Verdict recorded in `DEC-BENCH-B4-V3-001` (pending run).
