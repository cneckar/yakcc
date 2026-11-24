// SPDX-License-Identifier: MIT
// Metrics for B12. Ranks are 1-based; null means the target is not in the list.

/** Share of positive rows whose target is within the first k. */
export function recallAt(rows, k) {
  const pos = rows.filter((r) => r.positive);
  if (pos.length === 0) return null;
  return pos.filter((r) => r.targetRank !== null && r.targetRank <= k).length / pos.length;
}

/** Mean reciprocal rank over positive rows (0 for a miss). */
export function mrr(rows) {
  const pos = rows.filter((r) => r.positive);
  if (pos.length === 0) return null;
  return pos.reduce((s, r) => s + (r.targetRank ? 1 / r.targetRank : 0), 0) / pos.length;
}

/**
 * Area under the ROC curve: the probability that a randomly chosen positive outranks a
 * randomly chosen negative (ties count half). null when either class is empty.
 */
export function auroc(scores, labels) {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** The summary of one configuration's rows. */
export function summarizeConfig(rows) {
  const pos = rows.filter((r) => r.positive);
  const neg = rows.filter((r) => !r.positive);
  const accepted = rows.filter((r) => r.accept);
  const shortlisted = pos.filter((r) => r.shortlistRank !== null).length;
  return {
    recallAt1: recallAt(rows, 1),
    recallAt5: recallAt(rows, 5),
    recallAt10: recallAt(rows, 10),
    recallAt50: recallAt(rows, 50),
    mrr: mrr(rows),
    shortlistRecall: pos.length === 0 ? null : shortlisted / pos.length,
    // Reuse decision: of the accepted top candidates, how many were right; of the positives,
    // how many were accepted correctly; of the negatives, how many were wrongly accepted.
    accepted: accepted.length,
    acceptPrecision:
      accepted.length === 0 ? null : accepted.filter((r) => r.top1Correct).length / accepted.length,
    acceptRecall:
      pos.length === 0 ? null : pos.filter((r) => r.accept && r.top1Correct).length / pos.length,
    falseAcceptRate: neg.length === 0 ? null : neg.filter((r) => r.accept).length / neg.length,
    // The stricter rule: reuse only when exactly one shortlisted candidate reproduced every
    // example; with two or more, the examples do not decide, and the caller should add one.
    uniquePrecision: (() => {
      const u = rows.filter((r) => r.acceptUnique);
      return u.length === 0 ? null : u.filter((r) => r.top1Correct).length / u.length;
    })(),
    uniqueRecall:
      pos.length === 0
        ? null
        : pos.filter((r) => r.acceptUnique && r.top1Correct).length / pos.length,
    uniqueFalseAccept:
      neg.length === 0 ? null : neg.filter((r) => r.acceptUnique).length / neg.length,
    ambiguous: rows.filter((r) => r.accept && r.passingCount > 1).length,
    // Does the confidence in the top candidate separate right answers from wrong ones
    // (including every negative, whose top candidate is wrong by definition)?
    auroc: auroc(
      rows.map((r) => r.confidence),
      rows.map((r) => r.top1Correct),
    ),
  };
}
