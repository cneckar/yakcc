# Calibration Investigation — Cosine Distance Distribution

**WI-V3-DISCOVERY-CALIBRATION-FIX** (issue #258)
**Generated:** 2026-05-10T18:09:46.378Z
**HEAD SHA:** 31192ca
**Provider:** yakcc/offline-blake3-stub (OFFLINE)

## Per-Query Results

| Entry ID | top1 correct? | cosineDistance | combinedScore (1-d/2) | rank of expectedAtom |
|----------|---------------|----------------|-----------------------|----------------------|
| seed-ascii-char-001 | NO | 1.387907 | 0.306046 | 4 |
| seed-digit-001 | NO | 1.327627 | 0.336186 | 5 |
| seed-bracket-001 | YES | 1.384662 | 0.307669 | 1 |
| seed-comma-001 | YES | 1.393023 | 0.303489 | 1 |
| seed-integer-001 | NO | 1.380464 | 0.309768 | 4 |

## Correct Top-1 Hit Distance Distribution

- Count: 2/5
- cosineDistance range: [1.3847, 1.3930]
- cosineDistance avg: 1.3888
- combinedScore (1-d/2) range: [0.3035, 0.3077]
- M1 hits at threshold 0.50: 0/2
- M1 hits at threshold 0.40: 0/2
- M1 hits at threshold 0.30: 2/2