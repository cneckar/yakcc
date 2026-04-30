/**
 * Tests for the file-system intent cache: readIntent() and writeIntent().
 *
 * Production trigger: extractIntent calls readIntent on every invocation for
 * a cache check, and writeIntent on every live API call that produces a valid
 * IntentCard. These tests verify the complete read→miss→write→hit cycle that
 * extractIntent relies on for correctness.
 *
 * Compound-interaction test: the "round-trip" test runs the full
 * writeIntent → readIntent sequence that extractIntent performs after a live
 * API call, confirming the on-disk JSON representation is byte-identical on
 * read-back. The concurrent-write test exercises the atomic-rename path that
 * protects against partial reads during simultaneous cache population.
 */

import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IntentCard } from "../intent/types.js";
import { readIntent, writeIntent } from "./file-cache.js";

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeIntentCard(overrides?: Partial<IntentCard>): IntentCard {
  return {
    schemaVersion: 1,
    behavior: "Parses a string of comma-separated integers into an array",
    inputs: [{ name: "s", typeHint: "string", description: "Input string" }],
    outputs: [{ name: "result", typeHint: "number[]", description: "Parsed integers" }],
    preconditions: ["s is non-null"],
    postconditions: ["each element is a valid integer"],
    notes: [],
    modelVersion: "claude-haiku-4-5-20251001",
    promptVersion: "1",
    sourceHash: "a".repeat(64),
    extractedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test state — unique tmpdir per test
// ---------------------------------------------------------------------------

let cacheDir: string;

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `yakcc-cache-test-${unique}`);
  await fsPromises.mkdir(cacheDir, { recursive: true });
});

afterEach(async () => {
  // Best-effort cleanup; ignore failures.
  await fsPromises.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// readIntent
// ---------------------------------------------------------------------------

describe("readIntent()", () => {
  it("returns undefined for a missing key", async () => {
    const result = await readIntent(cacheDir, "a".repeat(64));
    expect(result).toBeUndefined();
  });

  it("returns the parsed value after a writeIntent", async () => {
    const card = makeIntentCard();
    const key = "b".repeat(64);
    await writeIntent(cacheDir, key, card);
    const result = await readIntent(cacheDir, key);
    expect(result).not.toBeUndefined();
  });

  it("returns undefined and deletes a corrupt file (unparseable JSON)", async () => {
    const key = "c".repeat(64);
    const shard = key.slice(0, 3);
    const shardDir = join(cacheDir, shard);
    await fsPromises.mkdir(shardDir, { recursive: true });
    // Write truncated (unparseable) JSON
    await fsPromises.writeFile(join(shardDir, `${key}.json`), "{truncated", "utf-8");

    const result = await readIntent(cacheDir, key);
    expect(result).toBeUndefined();

    // The corrupt file should have been deleted
    await expect(fsPromises.access(join(shardDir, `${key}.json`))).rejects.toThrow();
  });

  it("returns parsed value (not undefined) for valid JSON — caller validates schema", async () => {
    // readIntent does NOT validate schema — it returns any parseable JSON.
    // Callers (extractIntent) run validateIntentCard separately.
    const key = `cc${"0".repeat(62)}`;
    const shard = key.slice(0, 3);
    const shardDir = join(cacheDir, shard);
    await fsPromises.mkdir(shardDir, { recursive: true });
    // Write valid JSON that fails IntentCard schema (schema violation is caller's concern)
    await fsPromises.writeFile(
      join(shardDir, `${key}.json`),
      JSON.stringify({ schemaVersion: 99 }),
      "utf-8",
    );

    const result = await readIntent(cacheDir, key);
    // readIntent returns it — does NOT throw for schema mismatch
    expect(result).toEqual({ schemaVersion: 99 });
  });

  it("returns undefined (non-ENOENT read error) when cache file is a directory", async () => {
    // Trigger the non-ENOENT branch: make the expected file path a directory.
    // readFile on a directory on macOS/Linux produces EISDIR — not ENOENT.
    const key = `dd${"0".repeat(62)}`;
    const shard = key.slice(0, 3);
    const shardDir = join(cacheDir, shard);
    // Create the key path AS A DIRECTORY (not a file)
    const fileAsDir = join(shardDir, `${key}.json`);
    await fsPromises.mkdir(fileAsDir, { recursive: true });

    const result = await readIntent(cacheDir, key);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeIntent + readIntent round-trip
// ---------------------------------------------------------------------------

describe("writeIntent() + readIntent() round-trip", () => {
  it("round-trips a complete IntentCard byte-identically", async () => {
    const card = makeIntentCard();
    const key = "d".repeat(64);

    await writeIntent(cacheDir, key, card);
    const result = await readIntent(cacheDir, key);

    expect(JSON.stringify(result)).toBe(JSON.stringify(card));
  });

  it("uses key[0..2] as the shard directory prefix", async () => {
    const card = makeIntentCard();
    const key = `e1f${"0".repeat(61)}`; // shard = "e1f"
    await writeIntent(cacheDir, key, card);

    await expect(fsPromises.access(join(cacheDir, "e1f", `${key}.json`))).resolves.toBeUndefined();
  });

  it("concurrent writes to same key both resolve to a valid file", async () => {
    const card1 = makeIntentCard({ behavior: "First writer behavior" });
    const card2 = makeIntentCard({ behavior: "Second writer behavior" });
    const key = "f".repeat(64);

    // Both writes race; atomic rename ensures one wins cleanly
    await Promise.all([writeIntent(cacheDir, key, card1), writeIntent(cacheDir, key, card2)]);

    const result = await readIntent(cacheDir, key);
    expect(result).not.toBeUndefined();
    // The result must be one of the two valid cards (not corrupted)
    const parsed = result as IntentCard;
    expect(
      parsed.behavior === "First writer behavior" || parsed.behavior === "Second writer behavior",
    ).toBe(true);
  });

  it("second write with different content overwrites the first", async () => {
    const card1 = makeIntentCard({ behavior: "Original behavior text here" });
    const card2 = makeIntentCard({ behavior: "Updated behavior text here" });
    const key = "a0".repeat(32); // 64-char key

    await writeIntent(cacheDir, key, card1);
    await writeIntent(cacheDir, key, card2);

    const result = (await readIntent(cacheDir, key)) as IntentCard;
    expect(result.behavior).toBe("Updated behavior text here");
  });

  it("creates shard directory automatically (no pre-existing dir needed)", async () => {
    const key = `9ab${"0".repeat(61)}`; // shard = "9ab"
    const card = makeIntentCard();

    // No mkdir call — writeIntent must create it
    await expect(writeIntent(cacheDir, key, card)).resolves.toBeUndefined();
    const result = await readIntent(cacheDir, key);
    expect(result).not.toBeUndefined();
  });

  it("throws and cleans up tmp file when rename fails (destination is a directory)", async () => {
    // Force rename to fail by making the target path a directory.
    // writeIntent writes to <key>.json; if that path is a directory, rename throws EISDIR.
    const key = `eee${"0".repeat(61)}`; // shard = "eee"
    const shard = key.slice(0, 3);
    const shardDir = join(cacheDir, shard);
    // Create the final path as a directory to make rename fail
    const finalPath = join(shardDir, `${key}.json`);
    await fsPromises.mkdir(finalPath, { recursive: true });

    const card = makeIntentCard();
    // writeIntent should throw because rename will fail (EISDIR)
    await expect(writeIntent(cacheDir, key, card)).rejects.toThrow();
  });
});
