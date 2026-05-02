// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: AnthropicLikeClient is a minimal interface
// extracted from the SDK's messages.create shape. This indirection allows tests
// to inject a synchronous mock without importing the SDK, and allows the lazy
// import inside createDefaultAnthropicClient to remain the only SDK entry point.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Lazily importing the SDK keeps `import @yakcc/shave` lightweight
// for callers that never need live extraction (offline/cached workflows). The
// interface boundary makes this testable without network access.

/**
 * A single text content block from the Anthropic messages API.
 * Only the text variant is expected from extraction responses.
 */
export interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

/**
 * The subset of an Anthropic message response used by extractIntent.
 */
export interface AnthropicMessageResponse {
  readonly content: ReadonlyArray<AnthropicTextBlock | { readonly type: string }>;
}

/**
 * Parameters accepted by the messages.create call used for intent extraction.
 */
export interface AnthropicCreateParams {
  readonly model: string;
  readonly system: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
  readonly max_tokens: number;
}

/**
 * Minimal client interface that extractIntent depends on.
 *
 * The real Anthropic SDK satisfies this shape. Tests may inject any object
 * implementing this interface to avoid network calls.
 */
export interface AnthropicLikeClient {
  create(params: AnthropicCreateParams): Promise<AnthropicMessageResponse>;
}

/**
 * Construct the default AnthropicLikeClient using the official SDK.
 *
 * The SDK is imported lazily inside this function body so that simply
 * importing @yakcc/shave does not pull the SDK into the caller's bundle.
 * This function should only be called when a live API call is required.
 *
 * @param apiKey - The Anthropic API key (ANTHROPIC_API_KEY env var value).
 */
export async function createDefaultAnthropicClient(apiKey: string): Promise<AnthropicLikeClient> {
  // Lazy import: the SDK is not required unless live extraction is requested.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  return {
    create(params: AnthropicCreateParams): Promise<AnthropicMessageResponse> {
      return client.messages.create({
        model: params.model,
        system: params.system,
        messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: params.max_tokens,
      }) as Promise<AnthropicMessageResponse>;
    },
  };
}
