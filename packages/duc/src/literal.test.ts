// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { liftAtom } from "./lift.js";
import { parseLineForm } from "./line-form.js";
import { normalizeLiteral } from "./literal.js";

const id = (body: string): string => graphIdentity(liftAtom(`export function f(): unknown { ${body} }`));

describe("literal labels in normal form", () => {
  it("a string is the same literal whatever its quotes", () => {
    expect(id("return 'a\\n';")).toBe(id('return "a\\n";'));
    expect(id("return `a`;")).toBe(id('return "a";'));
  });
  it("a number is the same literal however it is written", () => {
    expect(id("return 1.0;")).toBe(id("return 1;"));
    expect(id("return 0xff;")).toBe(id("return 255;"));
  });
  it("different values stay different", () => {
    expect(id("return 'a';")).not.toBe(id("return 'b';"));
    expect(id("return 1;")).not.toBe(id("return '1';"));
  });
  it("the line form accepts any quote style", () => {
    expect(graphIdentity(parseLineForm("lit \"'a'\" -> x\nout x"))).toBe(graphIdentity(parseLineForm('lit "\\"a\\"" -> x\nout x')));
  });
  it("other literals keep their text", () => {
    expect(normalizeLiteral("true")).toBe("true");
    expect(normalizeLiteral("/a+/g")).toBe("/a+/g");
    expect(normalizeLiteral("10n")).toBe("10n");
  });
});
