// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/harness/verify-v4.mjs
//
// Per-task SHA-256 verification at suite-load time.
// Identical logic to bench/B4-tokens-v3/harness/verify.mjs; adapted for v4 paths.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Verify all task prompt files against their SHA-256 hashes in tasks.json.
 * Throws an Error immediately on the first drift detected.
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
      const lfBytes = Buffer.from(rawBytes.toString('binary').replace(/\r\n/g, '\n'), 'binary');
      const actualLf = createHash('sha256').update(lfBytes).digest('hex');
      if (actualLf === task.sha256) actual = actualLf;
    }

    if (actual !== task.sha256) {
      throw new Error(
        `SHA-256 drift detected for ${task.prompt_file}:\n` +
        `  expected: ${task.sha256}\n  actual:   ${actualRaw}\n` +
        'Task prompt has changed. Update tasks.json with corrected hashes.',
      );
    }
    console.log(`  [OK] ${task.id} — sha256=${actual.slice(0, 16)}...`);
  }
  console.log(`[VERIFY] All ${manifest.tasks.length} task prompts verified.\n`);
}
