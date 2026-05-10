import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LicenseRefusedError, shave } from "./index.js";
import type { ShaveRegistryView } from "./types.js";

const mockRegistry: ShaveRegistryView = {
  selectBlocks: async () => [],
  getBlock: async () => undefined,
  findByCanonicalAstHash: async () => [],
};

const tempFiles: string[] = [];

async function writeTempFile(content: string): Promise<string> {
  const path = join(tmpdir(), `shave-test-${randomUUID()}.ts`);
  await writeFile(path, content, "utf-8");
  tempFiles.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempFiles.map((p) => rm(p, { force: true })));
  tempFiles.length = 0;
});

describe("shave() — file ingestion pipeline (WI-014-01)", () => {
  it("throws LicenseRefusedError for GPL-licensed source before reaching Anthropic", async () => {
    const path = await writeTempFile(
      "// SPDX-License-Identifier: GPL-3.0-or-later\nfunction foo() {}\n",
    );
    await expect(shave(path, mockRegistry)).rejects.toBeInstanceOf(LicenseRefusedError);
  });

  it("throws an error mentioning the path when the source file is not found", async () => {
    const fake = join(tmpdir(), `does-not-exist-${randomUUID()}.ts`);
    await expect(shave(fake, mockRegistry)).rejects.toThrow(/source file not found/);
    await expect(shave(fake, mockRegistry)).rejects.toThrow(fake);
  });

  it("throws an error mentioning the path includes the basename in error context", async () => {
    const fake = join(tmpdir(), `also-not-real-${randomUUID()}.ts`);
    await expect(shave(fake, mockRegistry)).rejects.toThrow(Error);
  });
});
