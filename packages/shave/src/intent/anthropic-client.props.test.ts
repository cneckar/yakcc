// SPDX-License-Identifier: MIT
// Vitest harness for anthropic-client.props.ts — thin runner only.
// Each export from the corpus is driven through fc.assert() here.

import * as fc from "fast-check";
import { describe, it } from "vitest";
import * as Props from "./anthropic-client.props.js";

describe("anthropic-client.ts — Path A property corpus", () => {
  it("property: AnthropicTextBlock shape conformance", () => {
    fc.assert(Props.prop_anthropicClient_AnthropicTextBlock_shape_conformance);
  });

  it("property: AnthropicLikeClient mock satisfies interface", async () => {
    await fc.assert(Props.prop_anthropicClient_mock_satisfies_interface);
  });
});
