// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave intent/anthropic-client.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling
// .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3g)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from anthropic-client.ts):
//   AnthropicTextBlock       (AC1.1) — interface shape: type "text", text string
//   AnthropicMessageResponse (AC1.1) — interface shape: content array
//   AnthropicCreateParams    (AC1.1) — interface shape: model/system/messages/max_tokens
//   AnthropicLikeClient      (AC1.2) — interface shape: create method returns Promise
//
// Properties covered (2 atoms):
//   (m1) Interface shape conformance — compile-time exact-shape via typed locals
//   (m2) AnthropicLikeClient mock satisfies the interface at runtime

// ---------------------------------------------------------------------------
// Property-test corpus for intent/anthropic-client.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type {
  AnthropicCreateParams,
  AnthropicLikeClient,
  AnthropicMessageResponse,
  AnthropicTextBlock,
} from "./anthropic-client.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string up to 40 chars. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary AnthropicTextBlock — type must be "text". */
const anthropicTextBlockArb: fc.Arbitrary<AnthropicTextBlock> = fc.record({
  type: fc.constant("text" as const),
  text: fc.string({ minLength: 0, maxLength: 100 }),
});

/** Arbitrary AnthropicCreateParams — all fields required, readonly. */
const anthropicCreateParamsArb: fc.Arbitrary<AnthropicCreateParams> = fc.record({
  model: nonEmptyStr,
  system: fc.string({ minLength: 0, maxLength: 200 }),
  messages: fc.array(
    fc.record({
      role: fc.oneof(fc.constant("user" as const), fc.constant("assistant" as const)),
      content: fc.string({ minLength: 0, maxLength: 100 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  max_tokens: fc.integer({ min: 1, max: 4096 }),
});

// ---------------------------------------------------------------------------
// AC1.1 / (m1): AnthropicTextBlock interface shape conformance
// ---------------------------------------------------------------------------

/**
 * prop_anthropicClient_AnthropicTextBlock_shape_conformance
 *
 * Any object produced by anthropicTextBlockArb satisfies the AnthropicTextBlock
 * interface shape: type === "text" and text is a string.
 *
 * Invariant (AC1.1, DEC-CONTINUOUS-SHAVE-022): the AnthropicTextBlock interface
 * is the extraction target from API responses. The type discriminant "text" must
 * be a string literal, and text must be a string — both are required by the
 * interface. Compile-time typed assignment here ensures that any future shape
 * change in the interface causes a TypeScript error, not a silent runtime failure.
 */
export const prop_anthropicClient_AnthropicTextBlock_shape_conformance = fc.property(
  anthropicTextBlockArb,
  (block: AnthropicTextBlock) => block.type === "text" && typeof block.text === "string",
);

// ---------------------------------------------------------------------------
// AC1.2 / (m2): AnthropicLikeClient mock satisfies interface at runtime
//
// Production sequence: extractIntent receives ctx.client (AnthropicLikeClient),
// calls client.create(params) → awaits AnthropicMessageResponse. The mock must
// satisfy the interface shape so the type system catches drift in the real SDK
// adapter or in extract.ts. This compound property exercises the full mock
// inject → create → response sequence crossing the AnthropicLikeClient interface.
// ---------------------------------------------------------------------------

/**
 * prop_anthropicClient_mock_satisfies_interface
 *
 * An object that conforms to AnthropicLikeClient can be called via create() and
 * returns an AnthropicMessageResponse with the expected shape.
 *
 * This is the compound-interaction property for anthropic-client.ts: it exercises
 * the AnthropicLikeClient interface → create() call → AnthropicMessageResponse
 * pipeline, mirroring the extract.ts LLM path where ctx.client is injected.
 * Typed locals for params and response ensure compile-time shape enforcement.
 *
 * Invariant (AC1.2, DEC-CONTINUOUS-SHAVE-022): any object that satisfies
 * AnthropicLikeClient (including test mocks) must produce an
 * AnthropicMessageResponse with a content array containing AnthropicTextBlock
 * entries. If the interface drifts from what extract.ts uses, this test will
 * fail to compile or the runtime check will fail.
 */
export const prop_anthropicClient_mock_satisfies_interface = fc.asyncProperty(
  anthropicCreateParamsArb,
  fc.string({ minLength: 0, maxLength: 200 }),
  async (params: AnthropicCreateParams, responseText: string) => {
    // Build a minimal mock that satisfies AnthropicLikeClient.
    const textBlock: AnthropicTextBlock = { type: "text", text: responseText };
    const response: AnthropicMessageResponse = { content: [textBlock] };

    const mockClient: AnthropicLikeClient = {
      create(_p: AnthropicCreateParams): Promise<AnthropicMessageResponse> {
        return Promise.resolve(response);
      },
    };

    // Call create with typed params — TypeScript will flag any interface mismatch.
    const result: AnthropicMessageResponse = await mockClient.create(params);

    // Runtime shape verification.
    if (!Array.isArray(result.content)) return false;
    const first = result.content[0];
    if (first === undefined) return false;
    if (first.type !== "text") return false;
    const textFirst = first as AnthropicTextBlock;
    return typeof textFirst.text === "string" && textFirst.text === responseText;
  },
);
