// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/verify.mjs
//
// @decision DEC-BENCH-B4-V3-VERIFY-001
// @title Per-task SHA-256 verification at suite-load time
// @status accepted
// @rationale
//   Per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001: oracle integrity requires that
//   prompt files are content-addressed and verified before any API call. SHA-256
//   hashes in tasks.json are the canonical source of truth. Any drift aborts the
//   harness before spending any budget.
//
//   CRLF normalization: Windows editors may introduce CRLF line endings. The
//   verifier tries raw bytes first, then LF-normalized bytes, accepting either.
//   This matches the behavior of bench/B4-tokens/harness/run.mjs loadAndVerifyTasks().
//
// Exports:
//   verifyTaskManifest(manifest, benchRoot) — throws on SHA-256 drift

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Verify all task prompt files against their SHA-256 hashes in tasks.json.
 * Throws an Error immediately on the first drift detected.
 *
 * @param {{ tasks: Array<{ id: string, prompt_file: string, sha256: string }> }} manifest
 * @param {string} benchRoot - Absolute path to bench/B4-tokens-v3/
 */
export function verifyTaskManifest(manifest, benchRoot) {
  console.log('[VERIFY] Verifying task prompt SHA-256 hashes...');
  for (const task of manifest.tasks) {
    const promptPath = join(benchRoot, task.prompt_file);
    if (!existsSync(promptPath)) {
      throw new Error(`Task prompt not found: ${promptPath}`);
    }
    const rawBytes = readFileSync(promptPath);
    const actualRaw = createHash('sha256').update(rawBytes).digest('hex');

    let actual = actualRaw;
    if (actual !== task.sha256) {
      // Try LF-normalized bytes (CRLF tolerance)
      const lfBytes = Buffer.from(rawBytes.toString('binary').replace(/\r\n/g, '\n'), 'binary');
      const actualLf = createHash('sha256').update(lfBytes).digest('hex');
      if (actualLf === task.sha256) actual = actualLf;
    }

    if (actual !== task.sha256) {
      throw new Error(
        `SHA-256 drift detected for ${task.prompt_file}:\n` +
        `  expected: ${task.sha256}\n  actual:   ${actualRaw}\n` +
        'Task prompt has changed. Update tasks.json with corrected hashes.'
      );
    }
    console.log(`  [OK] ${task.id} — sha256=${actual.slice(0, 16)}...`);
  }
  console.log(`[VERIFY] All ${manifest.tasks.length} task prompts verified.\n`);
}
