import { describe, expect, it } from "vitest";
import { detectLicense } from "./detector.js";

// ---------------------------------------------------------------------------
// SPDX comment detection
// ---------------------------------------------------------------------------

describe("detectLicense — SPDX comment", () => {
  it("detects SPDX-License-Identifier: MIT in a line comment", () => {
    const result = detectLicense("// SPDX-License-Identifier: MIT\nconst x = 1;");
    expect(result.identifier).toBe("MIT");
    expect(result.source).toBe("spdx-comment");
    expect(result.evidence).toMatch(/MIT/);
  });

  it("detects @license Apache-2.0 in a block comment (no colon)", () => {
    const result = detectLicense("/* @license Apache-2.0 */");
    expect(result.identifier).toBe("Apache-2.0");
    expect(result.source).toBe("spdx-comment");
  });

  it("detects @license with colon", () => {
    const result = detectLicense("// @license: ISC");
    expect(result.identifier).toBe("ISC");
    expect(result.source).toBe("spdx-comment");
  });

  it("SPDX takes precedence over header text when both present", () => {
    const mixed =
      "// SPDX-License-Identifier: Apache-2.0\n" +
      "// Permission is hereby granted, free of charge";
    const result = detectLicense(mixed);
    expect(result.identifier).toBe("Apache-2.0");
    expect(result.source).toBe("spdx-comment");
  });
});

// ---------------------------------------------------------------------------
// Public-domain dedication
// ---------------------------------------------------------------------------

describe("detectLicense — dedication", () => {
  it("detects Unlicense full preamble", () => {
    const unlicenseText =
      "This is free and unencumbered software released into the public domain.\n" +
      "Anyone is free to copy, modify, publish...";
    const result = detectLicense(unlicenseText);
    expect(result.identifier).toBe("Unlicense");
    expect(result.source).toBe("dedication");
  });

  it("detects generic public-domain phrase (not full Unlicense preamble)", () => {
    const result = detectLicense("Released into the public domain by the author.");
    expect(result.identifier).toBe("public-domain");
    expect(result.source).toBe("dedication");
  });
});

// ---------------------------------------------------------------------------
// Header-text patterns
// ---------------------------------------------------------------------------

describe("detectLicense — header-text", () => {
  it("detects MIT canonical preamble", () => {
    const result = detectLicense(
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
    );
    expect(result.identifier).toBe("MIT");
    expect(result.source).toBe("header-text");
  });

  it("detects Apache-2.0 via header text", () => {
    const result = detectLicense(
      "Licensed under the Apache License, Version 2.0 (the License)",
    );
    expect(result.identifier).toBe("Apache-2.0");
    expect(result.source).toBe("header-text");
  });

  it("detects Apache-2.0 via URL", () => {
    const result = detectLicense(
      "See http://www.apache.org/licenses/LICENSE-2.0",
    );
    expect(result.identifier).toBe("Apache-2.0");
    expect(result.source).toBe("header-text");
  });

  it("detects BSD-2-Clause (no 'Neither the name of' clause)", () => {
    const bsd2 =
      "Redistribution and use in source and binary forms, with or without " +
      "modification, are permitted provided that the following conditions are met:\n" +
      "1. Redistributions of source code must retain the above copyright notice.\n" +
      "2. Redistributions in binary form must reproduce the above copyright notice.";
    const result = detectLicense(bsd2);
    expect(result.identifier).toBe("BSD-2-Clause");
    expect(result.source).toBe("header-text");
  });

  it("detects BSD-3-Clause (with 'Neither the name of' clause)", () => {
    const bsd3 =
      "Redistribution and use in source and binary forms, with or without " +
      "modification, are permitted provided that the following conditions are met:\n" +
      "1. Redistributions of source code must retain the above copyright notice.\n" +
      "2. Redistributions in binary form must reproduce the above copyright notice.\n" +
      "3. Neither the name of the copyright holder nor the names of its contributors...";
    const result = detectLicense(bsd3);
    expect(result.identifier).toBe("BSD-3-Clause");
    expect(result.source).toBe("header-text");
  });

  it("detects ISC short preamble", () => {
    const result = detectLicense(
      "Permission to use, copy, modify, and/or distribute this software for any purpose",
    );
    expect(result.identifier).toBe("ISC");
    expect(result.source).toBe("header-text");
  });

  it("detects 0BSD preamble (must NOT match as ISC)", () => {
    const result = detectLicense(
      "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee",
    );
    expect(result.identifier).toBe("0BSD");
    expect(result.source).toBe("header-text");
  });
});

// ---------------------------------------------------------------------------
// No signal
// ---------------------------------------------------------------------------

describe("detectLicense — no-signal", () => {
  it("returns unknown for empty string", () => {
    const result = detectLicense("");
    expect(result.identifier).toBe("unknown");
    expect(result.source).toBe("no-signal");
    expect(result.evidence).toBeUndefined();
  });

  it("returns unknown for unrelated source text", () => {
    const result = detectLicense("export const foo = () => 42;");
    expect(result.identifier).toBe("unknown");
    expect(result.source).toBe("no-signal");
  });
});
