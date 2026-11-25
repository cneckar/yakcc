// SPDX-License-Identifier: Apache-2.0
/**
 * `yakcc build --native <entry> [--target <t>] [-o <out>] [--no-libc]` (#1333): an ECMAScript or
 * TypeScript program built into an executable. The entry module and every module it imports are
 * lifted, linked and lowered to native code with the yakcc runtime, and a generated main: the
 * arguments are `process.argv`, the exit code `process.exitCode` (1 for an exception nothing
 * catches). With `--no-libc` (x86_64-linux), no C library is linked: the runtime on Linux's system
 * calls alone.
 */
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { buildProgram } from "@yakcc/duc";
import type { Logger } from "../index.js";

export async function buildNative(argv: readonly string[], logger: Logger): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        native: { type: "boolean" },
        target: { type: "string", default: "x86_64-linux" },
        out: { type: "string", short: "o" },
        root: { type: "string" },
        "no-libc": { type: "boolean" },
      },
      allowPositionals: true,
    });
  } catch (e) {
    logger.error(`error: ${(e as Error).message}`);
    return 1;
  }
  const entry = parsed.positionals[0];
  if (entry === undefined) {
    logger.error(
      "error: yakcc build --native needs an entry module: yakcc build --native <entry> [-o <out>]",
    );
    return 1;
  }
  const out = (parsed.values.out as string | undefined) ?? basename(entry, extname(entry));
  try {
    const built = buildProgram(entry, out, {
      target: parsed.values.target as string,
      ...(parsed.values.root !== undefined ? { root: parsed.values.root as string } : {}),
      ...(parsed.values["no-libc"] === true ? { noLibc: true } : {}),
    });
    logger.log(
      `built ${built.executable} from ${built.modules.length} modules (${parsed.values.target})`,
    );
    return 0;
  } catch (e) {
    logger.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
