// SPDX-License-Identifier: MIT
/**
 * #619 — TS-compiled CJS prelude walk regression tests.
 *
 * Proves that `decompose()` succeeds on the four canonical TS-compiled CJS prelude shapes
 * without throwing `DidNotReachAtomError` or `RecursionDepthExceededError`.
 *
 * W1 probe finding (2026-05-17): The three simpler zod entry-point fixtures
 * (index.cjs, v3/external.cjs, v3/index.cjs) already decompose successfully — the
 * ParenthesizedExpression unwrap from PR #627 (DEC-WI585-PARENTHESIZED-EXPRESSION-UNWRAP-001)
 * already handles the prelude's `(this && this.__X) || (Object.create ? (...) : (...))` shape.
 * No additional engine change is required for the prelude itself.
 *
 * v3/types.cjs stubs due to RecursionDepthExceededError (depth 25 > maxDepth 24) on its
 * 3775-line monolith body — a depth-limit issue, NOT a prelude issue. That is path (a) of
 * DEC-FIX-619-TYPES-CJS-POST-FIX-001 (keep stubbed; see zod-headline-bindings.test.ts).
 *
 * @decision DEC-FIX-619-PRELUDE-WALK-001
 * title: TS-compiled CJS prelude decomposes via PR #627's ParenthesizedExpression branch
 * status: decided
 * rationale:
 *   The prelude pattern `var __X = (this && this.__X) || (Object.create ? (fn) : fn);`
 *   decomposes via the existing BinaryExpression → [left, right] branch (kind 223) plus
 *   the ParenthesizedExpression → [inner] branch (DEC-WI585-PARENTHESIZED-EXPRESSION-UNWRAP-001,
 *   PR #627 cbefa3c). The ConditionalExpression branch handles the ternary. FunctionExpression
 *   bodies with ≤1 CF boundary are atoms; those with >1 boundary descend further into Block
 *   statements. No new SyntaxKind branch is needed for the prelude itself.
 *   The W1 probe confirmed this: index.cjs/external.cjs/v3/index.cjs all return moduleCount≥1
 *   after PR #627 landed. The Group A assertions in zod-headline-bindings.test.ts were stale
 *   (written before PR #627) and needed to be flipped to reflect engine reality.
 * alternatives:
 *   A. Add a dedicated "TS prelude" branch in decomposableChildrenOf — rejected; the
 *      existing general-purpose branches already handle the prelude correctly. A
 *      special-case branch would be parallel-authority (DEC-FIX-619-NO-PRELUDE-STRIPPING-001).
 * consequences:
 *   - All four prelude variants in §A-§D below decompose; leafCount >= 1.
 *   - The three simpler zod entry-points (index.cjs, v3/external.cjs, v3/index.cjs) now
 *     produce moduleCount >= 1, stubCount == 0 — confirmed by Group A flips.
 *   - v3/types.cjs remains stubbed (depth limit, not prelude issue) — DEC-FIX-619-TYPES-CJS-POST-FIX-001(a).
 *   - v3/locales/en.cjs remains stubbed (TemplateExpression gap, #576-adjacent) — unchanged.
 */

import { describe, expect, it } from "vitest";
import { decompose } from "./recursion.js";

const emptyRegistry = {
  findByCanonicalAstHash: async () => [],
};

// ---------------------------------------------------------------------------
// §A — Single-helper prelude: only __createBinding
// Minimal prelude shape. The `||` BinaryExpression + ParenthesizedExpression
// ConditionalExpression walk must succeed with ≥1 leaf.
// ---------------------------------------------------------------------------

describe("decompose-prelude-walk -- §A single-helper (__createBinding only)", () => {
  it("decompose() succeeds and leafCount >= 1", { timeout: 30_000 }, async () => {
    const source = `"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
module.exports = {};
`;
    const tree = await decompose(source, emptyRegistry);
    expect(tree).toBeDefined();
    expect(tree.leafCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// §B — Two-helper partial prelude: __createBinding + __exportStar
// Mirrors the shape of v3/external.cjs (2-helper subset).
// Each helper line has the `(this && this.__X) || (Object.create ? fn : fn)` pattern.
// ---------------------------------------------------------------------------

describe("decompose-prelude-walk -- §B two-helper partial prelude (__createBinding + __exportStar)", () => {
  it("decompose() succeeds and leafCount >= 1", { timeout: 30_000 }, async () => {
    const source = `"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./foo.cjs"), exports);
`;
    const tree = await decompose(source, emptyRegistry);
    expect(tree).toBeDefined();
    expect(tree.leafCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// §C — Full four-helper prelude + Object.defineProperty(exports, "__esModule")
// The canonical tsc output for files that use all four helpers.
// Mirrors the prelude block of index.cjs / v3/index.cjs.
// ---------------------------------------------------------------------------

describe("decompose-prelude-walk -- §C full four-helper prelude (all helpers + __esModule)", () => {
  it("decompose() succeeds and leafCount >= 1", { timeout: 30_000 }, async () => {
    const source = `"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
`;
    const tree = await decompose(source, emptyRegistry);
    expect(tree).toBeDefined();
    expect(tree.leafCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// §D — Full four-helper prelude + body re-exports (mirrors v3/external.cjs shape)
// Adds 6 __exportStar(require(...)) calls after the prelude — the most complex
// single-file shape in the zod fixture set (2 helpers + 6 re-exports in the
// real external.cjs; 4 helpers + 6 re-exports here for maximum coverage).
// leafCount >= 6 because each __exportStar call is a separate leaf.
// ---------------------------------------------------------------------------

describe("decompose-prelude-walk -- §D full prelude + six body re-exports", () => {
  it("decompose() succeeds and leafCount >= 6", { timeout: 60_000 }, async () => {
    const source = `"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./errors.cjs"), exports);
__exportStar(require("./helpers/parseUtil.cjs"), exports);
__exportStar(require("./helpers/typeAliases.cjs"), exports);
__exportStar(require("./helpers/util.cjs"), exports);
__exportStar(require("./types.cjs"), exports);
__exportStar(require("./ZodError.cjs"), exports);
`;
    const tree = await decompose(source, emptyRegistry);
    expect(tree).toBeDefined();
    expect(tree.leafCount).toBeGreaterThanOrEqual(6);
  });
});
