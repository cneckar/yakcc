// SPDX-License-Identifier: MIT
// @decision DEC-EMBED-010: Local embeddings via @xenova/transformers behind a
// provider interface. Status: decided (MASTER_PLAN.md DEC-EMBED-010)
// Rationale: Local-first matches v0's no-network stance. The provider interface
// allows hosted providers to swap in later without changing call sites.
// Model: Xenova/bge-small-en-v1.5 (384 dimensions, ~25MB quantized, MIT license).
// (Default swapped from all-MiniLM-L6-v2 per DEC-EMBED-MODEL-DEFAULT-002, #326.)
// Lazy singleton load: the model is not loaded at import time; it loads on the
// first embed() call and is reused for all subsequent calls.

import { blake3 } from "@noble/hashes/blake3.js";
import { canonicalizeText } from "./canonicalize.js";
import type { ContractSpec } from "./index.js";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * A provider that converts a text string into a fixed-dimension embedding vector.
 *
 * Implementations must be deterministic: identical inputs must produce
 * byte-identical Float32Array outputs (modulo platform floating-point, but
 * transformers.js with the same ONNX model and same backend is deterministic).
 */
export interface EmbeddingProvider {
  /** Dimensionality of vectors produced by this provider. */
  readonly dimension: number;
  /** Stable identifier for the model/configuration, e.g. "Xenova/all-MiniLM-L6-v2". */
  readonly modelId: string;
  /**
   * Embed a text string and return a Float32Array of length `dimension`.
   * Must be deterministic: same input → same output, byte-for-byte.
   */
  embed(text: string): Promise<Float32Array>;
  /**
   * Optional batch embed. When implemented, sends `texts` as a single API
   * request rather than one request per text (more cost/rate-limit efficient).
   * Returns one Float32Array per input text, in the same order.
   *
   * Hosted providers (OpenAI, Voyage, openai-compatible) implement this.
   * Local and offline providers do not implement it — callers fall back to
   * repeated `embed()` calls when batch() is absent.
   */
  batch?(texts: string[]): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------------------
// Local provider (transformers.js)
// ---------------------------------------------------------------------------

// @decision DEC-1123-CONDITIONAL-OFFLINE-PIN-001
// @title Conditional allowRemoteModels=false for the shared embedder in air-gap mode
// @status accepted (WI-1123)
// @rationale The shared embedder is used by both online dev (legitimate first-run fetch)
//   and air-gap scenarios (B6a). Pinning allowRemoteModels=false globally would break
//   online dev; pinning conditionally behind YAKCC_AIRGAPPED=1 (existing env signal,
//   also readable via an explicit `airgapped` option for programmatic callers) matches
//   the DEC-MCP-RESOLVE-OFFLINE-GUARANTEE-001 pattern in resolve.ts without importing
//   its unconditional semantics. The env var propagates to all spawned child CLI
//   processes (the B6a harness sets it in spawnEnv), so every step is covered uniformly.
//   Fail-loud on cache miss: when pinned and the model is absent, @xenova throws — we
//   annotate the error message with "bge model not cached; provision it for air-gap"
//   so operators understand the required provisioning step.
//   Singleton caveat: the pin sets process-global env state; once a pipeline loads under
//   air-gap mode the env stays pinned for the process lifetime (correct for an air-gap run).
//   For mixed in-process tests, use the explicit airgapped option + a per-instance loader
//   (see embeddings.test.ts restore pattern) to avoid cross-contamination.

// @decision DEC-EMBED-MODEL-SELECTION-001
// @title DISCOVERY_EMBED_MODEL env-var for D5 embedding-model experiment (#326)
// @status accepted
// @rationale WI-V3-DISCOVERY-D5-EMBED-MODEL-EXPERIMENT requires running the full-corpus
//   harness against alternative embedding models without source edits. DISCOVERY_EMBED_MODEL
//   allows runtime model selection. The knob is intentionally experiment-scoped (not a
//   production config surface) — production always uses the committed LOCAL_MODEL_ID default.
//   If the experiment surfaces a better model, LOCAL_MODEL_ID and LOCAL_DIMENSION are updated
//   and DISCOVERY_EMBED_MODEL is no longer needed for that path.
//   DEC-CI-OFFLINE-001 preserved: all listed models are @xenova/transformers–compatible.
//   DEC-EMBED-010 preserved: model must be MIT or Apache 2.0 licensed.

/**
 * Default production model: bge-small-en-v1.5 (384 dims, MIT, ~25MB quantized).
 *
 * @decision DEC-EMBED-MODEL-DEFAULT-002 — bge-small-en-v1.5 as production default
 * @status accepted (operator 2026-05-11)
 * @rationale WI-V3-DISCOVERY-D5-EMBED-MODEL-EXPERIMENT (#326) ran the full-corpus
 *   harness against 3 alternative 384-dim models. Final numbers vs current default
 *   (all-MiniLM-L6-v2 post-#322):
 *
 *     Model                          M2     M3     M4    Strong-band N (M5 calibration)
 *     ---------------------          -----  ---    ----  -----------
 *     Xenova/all-MiniLM-L6-v2        62.5%  92.5%  0.742  (current, below M2 target)
 *     Xenova/bge-small-en-v1.5       70.0%  100%   0.823  36/50  ← winner
 *     Xenova/e5-small-v2             52.5%  87.5%  0.653  N/A (mis-calibrated)
 *     Xenova/all-MiniLM-L12-v2       72.5%  97.5%  0.824  0/50 (score collapse)
 *
 *   bge-small wins despite slightly lower M2 than L12 because:
 *   - M3=100% across all 5 categories (every right atom in top-10, every time)
 *   - Confidence distribution is operator-meaningful: 36/50 strong, 14/50 confident,
 *     0 weak/poor → the D2 auto-accept gate (combinedScore > 0.85 + gap > 0.15) fires
 *     on most queries
 *   - L12 by contrast puts 48/50 entries in the weak band — auto-accept never fires
 *     and downstream consumers always see "ambiguous, choose"
 *
 *   This swap closes the DEC-V3-INITIATIVE-002 measurement-first gate at the M2=70%
 *   target. D1 multi-vector remains paused (and falsified): bge-small's best category
 *   is multi-aspect at M2=87.5%, not its worst.
 */
const LOCAL_MODEL_ID = "Xenova/bge-small-en-v1.5";
/** Output dimension for the default production model. */
const LOCAL_DIMENSION = 384;

/**
 * Known offline-capable, MIT/Apache-2.0 licensed models and their output dimensions.
 * Used for default dimension lookup when `createLocalEmbeddingProvider` is called with
 * a model ID but no explicit dimension. Adding a model here is the canonical gate:
 * license check + offline verification must pass first.
 */
export const LOCAL_KNOWN_MODELS: ReadonlyMap<string, number> = new Map([
  ["Xenova/bge-small-en-v1.5", 384],       // CURRENT DEFAULT (per DEC-EMBED-MODEL-DEFAULT-002); MIT; ~25MB; retrieval-tuned
  ["Xenova/all-MiniLM-L6-v2", 384],        // prior default; MIT; ~25MB; below M2=70% target post-#322
  ["Xenova/all-MiniLM-L12-v2", 384],       // 12-layer same-family; Apache 2.0; ~34MB; M2=72.5% but mis-calibrated (#326 reject)
  ["Xenova/paraphrase-MiniLM-L6-v2", 384], // paraphrase-tuned; Apache 2.0; ~25MB; not benchmarked
  ["Xenova/e5-small-v2", 384],             // E5 retrieval model; MIT; ~25MB; M2=52.5% (#326 reject)
  ["Xenova/all-mpnet-base-v2", 768],       // larger model; Apache 2.0; ~86MB; requires FLOAT[768] schema (deferred)
]);

// @decision DEC-EMBED-SINGLETON-CLOSURE-001: Pipeline singleton via closure, not module-level let.
// Status: decided (WI-V2-02)
// Rationale: A module-level `let pipelinePromise` violates the no-mutable-globals strict-subset
// rule, which forbids top-level `let`/`var` declarations. Moving the mutable cell into a closure
// (via an IIFE-style factory that returns a getter function) satisfies the rule: the `let` lives
// inside a function scope, not at module scope. Runtime behaviour is byte-identical — the
// pipeline is still loaded lazily on first embed() call and cached for all subsequent calls.

// @decision DEC-EMBED-CUSTOM-MODEL-001: Per-model pipeline factory via makePipelineLoader.
// Status: decided (WI-V3-DISCOVERY-D5-EMBED-MODEL-EXPERIMENT, issue #326)
// Rationale: createLocalEmbeddingProvider now accepts an optional modelId to support embedding
// model swaps for benchmarking (DISCOVERY_EMBED_MODEL env var). Non-default model IDs get
// per-instance pipeline closures via makePipelineLoader; the default model still uses the
// module-level singleton to preserve DEC-EMBED-SINGLETON-CLOSURE-001 semantics for production.

/**
 * Returns true when the process is running in air-gap mode.
 *
 * Air-gap mode is signalled by `YAKCC_AIRGAPPED=1` — the same env var read by
 * `resolve.ts` (`DEC-MCP-RESOLVE-OFFLINE-GUARANTEE-001`). This is the canonical
 * single authority for the offline signal; we add a second reader here rather
 * than introduce a new env var.
 *
 * @internal — used by makePipelineLoader and exposed as an option seam for tests.
 */
function isAirgapMode(): boolean {
  return typeof process !== "undefined" && process.env.YAKCC_AIRGAPPED === "1";
}

/**
 * Create a lazy pipeline loader closure for the given model.
 *
 * When air-gap mode is active (YAKCC_AIRGAPPED=1 or the explicit `airgapped`
 * option), sets `env.allowRemoteModels = false` and asserts
 * `env.allowLocalModels = true` on the @xenova/transformers env before calling
 * `pipeline()`. This mirrors DEC-MCP-RESOLVE-OFFLINE-GUARANTEE-001 in resolve.ts
 * but conditionally, so online dev is unaffected.
 *
 * On cache miss with the pin active, @xenova throws — we surface a clear message
 * containing "bge model not cached; provision it for air-gap" so operators know
 * they need to provision the model before running air-gapped.
 *
 * @decision DEC-EMBED-LAZY-001: Dynamic import for lazy pipeline init.
 * Status: decided (WI-002)
 * Rationale: Static import triggers ONNX runtime at module load; dynamic defers to first use.
 */
function makePipelineLoader(modelId: string, airgapped?: boolean): () => Promise<unknown> {
  let pipelinePromise: Promise<unknown> | null = null;
  return (): Promise<unknown> => {
    if (pipelinePromise === null) {
      pipelinePromise = import("@xenova/transformers").then((mod) => {
        // DEC-1123-CONDITIONAL-OFFLINE-PIN-001: apply offline pin only in air-gap mode.
        const useAirgap = airgapped ?? isAirgapMode();
        if (useAirgap) {
          // Pin: no remote fetch allowed. allowLocalModels must be true (default, but assert).
          mod.env.allowRemoteModels = false;
          mod.env.allowLocalModels = true;
        }
        return mod.pipeline("feature-extraction", modelId).catch((err: unknown) => {
          if (useAirgap) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `bge model not cached; provision it for air-gap operation. Original error: ${msg}`,
            );
          }
          throw err;
        });
      });
    }
    return pipelinePromise;
  };
}

/** Module-level singleton pipeline for the default model in online mode (DEC-EMBED-SINGLETON-CLOSURE-001).
 * Air-gap mode gets a per-instance loader (see createLocalEmbeddingProvider) to avoid
 * pinning process-global env for the online singleton. */
const getPipeline: () => Promise<unknown> = makePipelineLoader(LOCAL_MODEL_ID, false);

/**
 * The output shape from transformers.js feature-extraction pipeline.
 * transformers.js returns a Tensor-like object; we access .data for the flat
 * Float32Array.
 */
interface TransformerOutput {
  data: Float32Array;
}

/**
 * Create a local EmbeddingProvider backed by transformers.js.
 *
 * The model is loaded lazily on first embed() call. Subsequent calls reuse the
 * same in-memory pipeline. Two calls with the same input text will return
 * byte-equal Float32Arrays.
 *
 * Default: Xenova/all-MiniLM-L6-v2, 384 dimensions, MIT license.
 *
 * Custom model support (DEC-EMBED-CUSTOM-MODEL-001): pass a different modelId
 * and optionally the corresponding dimension to benchmark alternative models.
 * If `dimension` is omitted, it is looked up from LOCAL_KNOWN_MODELS.
 * The schema is currently fixed at FLOAT[384]; 768-dim models require a schema
 * migration before they can be benchmarked against the bootstrap registry.
 *
 * Model selection when `modelId` is omitted (in priority order):
 *   1. `DISCOVERY_EMBED_MODEL` env var (experiment use)
 *   2. LOCAL_MODEL_ID default (`Xenova/bge-small-en-v1.5`)
 *
 * Air-gap mode (DEC-1123-CONDITIONAL-OFFLINE-PIN-001):
 *   Pass `options.airgapped = true` to force offline pin, or rely on the
 *   `YAKCC_AIRGAPPED=1` env var. When pinned and the model is not cached,
 *   the returned provider throws on the first embed() call with a message
 *   containing "bge model not cached; provision it for air-gap".
 */
export function createLocalEmbeddingProvider(
  modelId: string = (typeof process !== "undefined"
    ? (process.env.DISCOVERY_EMBED_MODEL ?? LOCAL_MODEL_ID)
    : LOCAL_MODEL_ID),
  dimension: number = LOCAL_KNOWN_MODELS.get(
    typeof process !== "undefined"
      ? (process.env.DISCOVERY_EMBED_MODEL ?? LOCAL_MODEL_ID)
      : LOCAL_MODEL_ID,
  ) ?? LOCAL_DIMENSION,
  options?: { airgapped?: boolean },
): EmbeddingProvider {
  // Effective air-gap mode: explicit option takes precedence over env var.
  const useAirgap = options?.airgapped ?? isAirgapMode();

  // Default model in online mode reuses the module-level singleton (DEC-EMBED-SINGLETON-CLOSURE-001).
  // Air-gap mode always gets a per-instance loader so the pin does not contaminate
  // the shared online singleton. Custom models also get per-instance loaders.
  const getLoader: () => Promise<unknown> =
    !useAirgap && modelId === LOCAL_MODEL_ID
      ? getPipeline
      : makePipelineLoader(modelId, useAirgap);

  return {
    dimension,
    modelId,

    async embed(text: string): Promise<Float32Array> {
      const pipe = getLoader() as Promise<
        (
          text: string,
          options: { pooling: string; normalize: boolean },
        ) => Promise<TransformerOutput>
      >;
      const extractor = await pipe;
      const output = await extractor(text, {
        pooling: "mean",
        normalize: true,
      });
      return new Float32Array(output.data);
    },
  };
}

// ---------------------------------------------------------------------------
// Offline provider (deterministic, network-free)
// ---------------------------------------------------------------------------

/** Model identifier used by the offline deterministic provider. */
const OFFLINE_MODEL_ID = "yakcc/offline-blake3-stub";
/** Dimension matches the local provider so the registry schema (DEC-EMBED-010) is unchanged. */
const OFFLINE_DIMENSION = 384;
/** 32 bytes per BLAKE3 output × 12 chained hashes = 384 dims. */
const OFFLINE_HASH_BLOCKS = 12;

// @decision DEC-EMBED-OFFLINE-PROVIDER-001
// @title Offline embedding provider for bootstrap and other no-network paths
// @status accepted
// @rationale `yakcc bootstrap` (DEC-V2-BOOT-NO-AI-CORPUS-001) is contractually
//   network-free, but the registry's storeBlock pipeline always generates an
//   embedding before insert. The local transformers.js provider downloads the
//   tokenizer from HuggingFace on first call, breaking offline-by-design paths.
//   This deterministic BLAKE3-derived provider satisfies the EmbeddingProvider
//   contract with zero network I/O. Vectors are L2-normalized so cosine
//   distance still behaves; semantic quality is intentionally absent — these
//   embeddings exist only because the schema requires a vector column, not
//   because bootstrap performs intent search. Same input → same vector,
//   byte-for-byte (BLAKE3 is deterministic).

/**
 * Create an offline EmbeddingProvider that produces deterministic vectors
 * via BLAKE3 hashing. No network I/O, no model downloads.
 *
 * Use this provider for bootstrap, CI, sandboxed test runs, and any other
 * code path that must remain network-free. The vectors are not semantically
 * meaningful (similar texts do not produce nearby vectors); they exist only
 * to satisfy the registry's vector-column schema. For semantic search, use
 * `createLocalEmbeddingProvider()` instead.
 *
 * Determinism: identical text inputs produce byte-identical Float32Array
 * outputs across machines, runs, and platforms.
 */
export function createOfflineEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: OFFLINE_DIMENSION,
    modelId: OFFLINE_MODEL_ID,

    async embed(text: string): Promise<Float32Array> {
      const encoder = new TextEncoder();
      const vec = new Float32Array(OFFLINE_DIMENSION);
      for (let block = 0; block < OFFLINE_HASH_BLOCKS; block++) {
        const hash = blake3(encoder.encode(`${text}|${block}`));
        for (let i = 0; i < 32; i++) {
          const byte = hash[i] ?? 0;
          vec[block * 32 + i] = (byte - 128) / 128;
        }
      }
      let norm = 0;
      for (let i = 0; i < OFFLINE_DIMENSION; i++) {
        const v = vec[i] ?? 0;
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < OFFLINE_DIMENSION; i++) {
          const v = vec[i] ?? 0;
          vec[i] = v / norm;
        }
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level default provider singleton
// ---------------------------------------------------------------------------

// @decision DEC-EMBED-SINGLETON-CLOSURE-002: Default-provider singleton via closure, not module-level let.
// Status: decided (WI-V2-02)
// Rationale: Same motivation as DEC-EMBED-SINGLETON-CLOSURE-001 — module-level `let` violates
// no-mutable-globals. The mutable cell is moved into a closure so the `let` lives inside a
// function scope. Runtime behaviour is byte-identical: the provider is created once on the first
// call to generateEmbedding() that omits an explicit provider, and reused for all subsequent calls.
const getDefaultProvider: () => EmbeddingProvider = (() => {
  let defaultProvider: EmbeddingProvider | null = null;
  return (): EmbeddingProvider => {
    if (defaultProvider === null) {
      defaultProvider = createLocalEmbeddingProvider();
    }
    return defaultProvider;
  };
})();

// ---------------------------------------------------------------------------
// Convenience export
// ---------------------------------------------------------------------------

/**
 * Generate a vector embedding for a ContractSpec.
 *
 * The embedding is produced by converting the spec to its canonical text form
 * (key-sorted JSON) and then embedding that text via the given provider.
 * If no provider is supplied, the module-level local provider is used.
 *
 * The result is a Float32Array of length `provider.dimension`.
 * The embedding is deterministic: the same spec and the same provider always
 * return the same vector.
 */
export async function generateEmbedding(
  spec: ContractSpec,
  provider?: EmbeddingProvider,
): Promise<Float32Array> {
  const p = provider ?? getDefaultProvider();
  const text = canonicalizeText(spec);
  return p.embed(text);
}

// ---------------------------------------------------------------------------
// Hosted embedding providers
// ---------------------------------------------------------------------------

// @decision DEC-EMBED-HOSTED-PROVIDER-001
// @title Hosted embedding providers: OpenAI, Voyage, OpenAI-compatible (issue #778)
// @status accepted (WI-778-BYO-EMBEDDING)
// @rationale BGE-small-en-v1.5 has known recall weaknesses on abstract/mathematical
//   code (external feedback 2026-05-19). Alpha testers who need higher-quality recall
//   can opt in to a hosted API via env vars. Default (local BGE-small) is unchanged;
//   no network calls without explicit opt-in (B6 air-gap cornerstone preserved).
//   Provider interface is unchanged; hosted providers implement the same embed() contract.

/** Default number of texts per batch API request (OpenAI / Voyage). */
export const HOSTED_EMBED_BATCH_SIZE_DEFAULT = 64;

const HOSTED_RETRY_MAX = 4;
const HOSTED_RETRY_BASE_MS = 2_000;

/** Retry a fetch call on 429 / 5xx with exponential backoff (max 4 retries, base 2 s). */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
  retryBaseMs: number = HOSTED_RETRY_BASE_MS,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= HOSTED_RETRY_MAX; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, retryBaseMs * 2 ** (attempt - 1)));
    }
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      lastErr = err;
      continue;
    }
    if (res.status !== 429 && res.status < 500) return res;
    lastErr = new Error(`HTTP ${res.status} from ${url}`);
  }
  throw lastErr ?? new Error(`fetch failed after ${HOSTED_RETRY_MAX} retries`);
}

// @decision DEC-EMBED-HOSTED-DISCLOSURE-001: First-use warning for hosted providers.
// @status accepted (WI-778-BYO-EMBEDDING)
// @rationale Hosted APIs send user code and intent text to third-party services,
//   breaking the B6 air-gap for embedding operations. Users must be informed on
//   first use. Set YAKCC_EMBEDDING_DISCLOSURE_ACK=1 to silence after reading.
const _warnedProviderKinds = new Set<string>();

function warnHostedProviderOnce(kind: string): void {
  if (typeof process !== "undefined" && process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK === "1")
    return;
  if (_warnedProviderKinds.has(kind)) return;
  _warnedProviderKinds.add(kind);
  // biome-ignore lint/suspicious/noConsole: intentional first-use disclosure
  console.warn(
    `warning: YAKCC_EMBEDDING_PROVIDER=${kind} sends emission intent text + atom\n` +
      `impl source to ${kind}. This breaks the air-gap (B6) cornerstone for embedding\n` +
      `operations. Set YAKCC_EMBEDDING_DISCLOSURE_ACK=1 to silence this warning.`,
  );
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

/**
 * Known output dimensions for OpenAI embedding models.
 *
 * text-embedding-3-small and text-embedding-3-large support the `dimensions`
 * parameter to reduce the output dimension. When `dimensions` is not specified,
 * these are the defaults. ada-002 is fixed at 1536.
 */
export const OPENAI_KNOWN_DIMENSIONS: ReadonlyMap<string, number> = new Map([
  ["text-embedding-ada-002", 1536],
  ["text-embedding-3-small", 1536],
  ["text-embedding-3-large", 3072],
]);

/** Configuration for the OpenAI embedding provider. */
export interface OpenAIEmbeddingConfig {
  /** Model name, e.g. "text-embedding-3-large". */
  readonly model: string;
  /** OpenAI API key (OPENAI_API_KEY). */
  readonly apiKey: string;
  /**
   * Request a specific output dimension from the model (text-embedding-3-* only).
   * When omitted, the model's native dimension is used.
   * Pass `dimensions: 384` to match the default registry schema.
   */
  readonly dimensions?: number;
  /** Number of texts per batch API request. Defaults to HOSTED_EMBED_BATCH_SIZE_DEFAULT. */
  readonly batchSize?: number;
  /** @internal Test seam: injectable fetch implementation. */
  readonly _fetch?: typeof fetch;
  /** @internal Test seam: retry base delay in ms (default 2000). */
  readonly _retryBaseMs?: number;
}

/**
 * Create an EmbeddingProvider backed by the OpenAI embeddings API.
 *
 * Sends code/intent text to OpenAI — breaks air-gap (B6) for embedding
 * operations. Set YAKCC_EMBEDDING_DISCLOSURE_ACK=1 to silence the first-use warning.
 *
 * Uses the batch API (`input: string[]`) for efficiency. Retries 429/5xx
 * with exponential backoff (max 4 retries, base 2 s).
 *
 * Model selection priority:
 *   1. `config.model` (explicit)
 *   2. `YAKCC_EMBEDDING_MODEL` env var (if not explicit)
 *
 * @param config - API key, model, optional dimension override.
 */
export function createOpenAIEmbeddingProvider(config: OpenAIEmbeddingConfig): EmbeddingProvider {
  const dimension =
    config.dimensions ??
    OPENAI_KNOWN_DIMENSIONS.get(config.model) ??
    1536;
  const batchSize = config.batchSize ?? HOSTED_EMBED_BATCH_SIZE_DEFAULT;
  const fetchImpl = config._fetch ?? fetch;
  const retryBaseMs = config._retryBaseMs ?? HOSTED_RETRY_BASE_MS;
  let warned = false;

  const embeddingRequest = async (texts: string[]): Promise<Float32Array[]> => {
    if (!warned) {
      warnHostedProviderOnce("openai");
      warned = true;
    }

    const body: Record<string, unknown> = {
      input: texts,
      model: config.model,
    };
    if (config.dimensions !== undefined) {
      body.dimensions = config.dimensions;
    }

    const res = await fetchWithRetry(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      fetchImpl,
      retryBaseMs,
    );

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenAI embeddings API error ${res.status}: ${txt}`);
    }

    const json = (await res.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    // Reconstruct in original order (API guarantees index field).
    const result = new Array<Float32Array>(texts.length);
    for (const item of json.data) {
      result[item.index] = new Float32Array(item.embedding);
    }
    return result as Float32Array[];
  };

  return {
    dimension,
    modelId: `openai/${config.model}${config.dimensions !== undefined ? `@${config.dimensions}` : ""}`,

    async embed(text: string): Promise<Float32Array> {
      const [vec] = await embeddingRequest([text]);
      if (vec === undefined) throw new Error("OpenAI returned no embedding");
      return vec;
    },

    async batch(texts: string[]): Promise<Float32Array[]> {
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const chunkResults = await embeddingRequest(chunk);
        results.push(...chunkResults);
      }
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// Voyage provider
// ---------------------------------------------------------------------------

/**
 * Known output dimensions for Voyage embedding models.
 */
export const VOYAGE_KNOWN_DIMENSIONS: ReadonlyMap<string, number> = new Map([
  ["voyage-code-2", 1536],
  ["voyage-2", 1024],
  ["voyage-large-2", 1536],
  ["voyage-large-2-instruct", 1024],
  ["voyage-3", 1024],
  ["voyage-3-lite", 512],
  ["voyage-code-3", 1024],
]);

/** Configuration for the Voyage AI embedding provider. */
export interface VoyageEmbeddingConfig {
  /** Model name, e.g. "voyage-code-2". */
  readonly model: string;
  /** Voyage API key (VOYAGE_API_KEY). */
  readonly apiKey: string;
  /** Number of texts per batch API request. Defaults to HOSTED_EMBED_BATCH_SIZE_DEFAULT. */
  readonly batchSize?: number;
  /** @internal Test seam: injectable fetch implementation. */
  readonly _fetch?: typeof fetch;
  /** @internal Test seam: retry base delay in ms (default 2000). */
  readonly _retryBaseMs?: number;
}

/**
 * Create an EmbeddingProvider backed by the Voyage AI embeddings API.
 *
 * Sends code/intent text to Voyage — breaks air-gap (B6) for embedding operations.
 * Set YAKCC_EMBEDDING_DISCLOSURE_ACK=1 to silence the first-use warning.
 *
 * Uses the batch API (`input: string[]`) for efficiency. Retries 429/5xx
 * with exponential backoff (max 4 retries, base 2 s).
 */
export function createVoyageEmbeddingProvider(config: VoyageEmbeddingConfig): EmbeddingProvider {
  const dimension = VOYAGE_KNOWN_DIMENSIONS.get(config.model) ?? 1024;
  const batchSize = config.batchSize ?? HOSTED_EMBED_BATCH_SIZE_DEFAULT;
  const fetchImpl = config._fetch ?? fetch;
  const retryBaseMs = config._retryBaseMs ?? HOSTED_RETRY_BASE_MS;
  let warned = false;

  const embeddingRequest = async (texts: string[]): Promise<Float32Array[]> => {
    if (!warned) {
      warnHostedProviderOnce("voyage");
      warned = true;
    }

    const res = await fetchWithRetry(
      "https://api.voyageai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ input: texts, model: config.model }),
      },
      fetchImpl,
      retryBaseMs,
    );

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Voyage embeddings API error ${res.status}: ${txt}`);
    }

    const json = (await res.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    const result = new Array<Float32Array>(texts.length);
    for (const item of json.data) {
      result[item.index] = new Float32Array(item.embedding);
    }
    return result as Float32Array[];
  };

  return {
    dimension,
    modelId: `voyage/${config.model}`,

    async embed(text: string): Promise<Float32Array> {
      const [vec] = await embeddingRequest([text]);
      if (vec === undefined) throw new Error("Voyage returned no embedding");
      return vec;
    },

    async batch(texts: string[]): Promise<Float32Array[]> {
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const chunkResults = await embeddingRequest(chunk);
        results.push(...chunkResults);
      }
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider (Ollama, LM Studio, vLLM, etc.)
// ---------------------------------------------------------------------------

/** Configuration for an OpenAI-compatible embedding endpoint. */
export interface OpenAICompatibleEmbeddingConfig {
  /**
   * Base URL of the OpenAI-compatible server, e.g. "http://localhost:11434/v1".
   * Must NOT have a trailing slash.
   */
  readonly baseUrl: string;
  /** Model name, e.g. "nomic-embed-text". */
  readonly model: string;
  /**
   * Output dimension of the model. Required because dimensions cannot be
   * inferred for arbitrary self-hosted models.
   */
  readonly dimension: number;
  /** Optional API key. Omit for unauthenticated local servers. */
  readonly apiKey?: string;
  /** Number of texts per batch request. Defaults to HOSTED_EMBED_BATCH_SIZE_DEFAULT. */
  readonly batchSize?: number;
  /** @internal Test seam: injectable fetch implementation. */
  readonly _fetch?: typeof fetch;
  /** @internal Test seam: retry base delay in ms (default 2000). */
  readonly _retryBaseMs?: number;
}

/**
 * Create an EmbeddingProvider backed by any OpenAI-compatible embeddings endpoint.
 *
 * Supports Ollama, LM Studio, vLLM, and any server that implements
 * `POST /v1/embeddings` with `{ input: string[], model: string }` request and
 * `{ data: [{ index: number, embedding: number[] }] }` response.
 *
 * Local endpoints (Ollama, LM Studio) do NOT send data externally — air-gap
 * is preserved if the server runs locally. The first-use warning is only shown
 * if `YAKCC_EMBEDDING_PROVIDER=openai-compatible` (generic label for user clarity).
 *
 * Retries 429/5xx with exponential backoff (max 4 retries, base 2 s).
 */
export function createOpenAICompatibleEmbeddingProvider(
  config: OpenAICompatibleEmbeddingConfig,
): EmbeddingProvider {
  const batchSize = config.batchSize ?? HOSTED_EMBED_BATCH_SIZE_DEFAULT;
  const fetchImpl = config._fetch ?? fetch;
  const retryBaseMs = config._retryBaseMs ?? HOSTED_RETRY_BASE_MS;
  let warned = false;

  const embeddingRequest = async (texts: string[]): Promise<Float32Array[]> => {
    if (!warned) {
      warnHostedProviderOnce("openai-compatible");
      warned = true;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey !== undefined) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const res = await fetchWithRetry(
      `${config.baseUrl}/embeddings`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ input: texts, model: config.model }),
      },
      fetchImpl,
      retryBaseMs,
    );

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenAI-compatible embeddings API error ${res.status}: ${txt}`);
    }

    const json = (await res.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    const result = new Array<Float32Array>(texts.length);
    for (const item of json.data) {
      result[item.index] = new Float32Array(item.embedding);
    }
    return result as Float32Array[];
  };

  return {
    dimension: config.dimension,
    modelId: `openai-compatible/${config.model}`,

    async embed(text: string): Promise<Float32Array> {
      const [vec] = await embeddingRequest([text]);
      if (vec === undefined) throw new Error("OpenAI-compatible server returned no embedding");
      return vec;
    },

    async batch(texts: string[]): Promise<Float32Array[]> {
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const chunkResults = await embeddingRequest(chunk);
        results.push(...chunkResults);
      }
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// Env-var-driven provider resolution
// ---------------------------------------------------------------------------

// @decision DEC-EMBED-ENV-RESOLUTION-001
// @title resolveEmbeddingProviderFromEnv reads YAKCC_EMBEDDING_PROVIDER and creates provider
// @status accepted (WI-778-BYO-EMBEDDING)
// @rationale Single function encapsulates env-var precedence. Priority:
//   1. CLI flags (handled by callers via explicit config — not this function's concern)
//   2. Env vars (YAKCC_EMBEDDING_PROVIDER + model/key vars)
//   3. Persisted rc (read by CLI init path — callers may pass rc config)
//   4. Default: local BGE-small (zero network, no API key required)

/**
 * Resolve an EmbeddingProvider from environment variables.
 *
 * Reads `YAKCC_EMBEDDING_PROVIDER` and the accompanying model/key env vars.
 * Returns `null` if no provider env var is set (caller should use the local default).
 *
 * Provider env-var matrix:
 * ```
 * YAKCC_EMBEDDING_PROVIDER=openai
 *   YAKCC_EMBEDDING_MODEL  (default: "text-embedding-3-large")
 *   OPENAI_API_KEY
 *   YAKCC_EMBEDDING_DIMENSIONS  (optional; for text-embedding-3-* models)
 *
 * YAKCC_EMBEDDING_PROVIDER=voyage
 *   YAKCC_EMBEDDING_MODEL  (default: "voyage-code-2")
 *   VOYAGE_API_KEY
 *
 * YAKCC_EMBEDDING_PROVIDER=openai-compatible
 *   YAKCC_EMBEDDING_BASE_URL   (required, e.g. "http://localhost:11434/v1")
 *   YAKCC_EMBEDDING_MODEL      (required)
 *   YAKCC_EMBEDDING_DIMENSION  (required)
 *   YAKCC_EMBEDDING_API_KEY    (optional)
 * ```
 *
 * @returns An EmbeddingProvider, or null if YAKCC_EMBEDDING_PROVIDER is not set.
 * @throws If provider is set but required env vars are missing.
 */
export function resolveEmbeddingProviderFromEnv(): EmbeddingProvider | null {
  if (typeof process === "undefined") return null;
  const providerKind = process.env.YAKCC_EMBEDDING_PROVIDER;
  if (providerKind === undefined || providerKind === "" || providerKind === "local") return null;

  if (providerKind === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "YAKCC_EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY to be set",
      );
    }
    const model = process.env.YAKCC_EMBEDDING_MODEL ?? "text-embedding-3-large";
    const dimsRaw = process.env.YAKCC_EMBEDDING_DIMENSIONS;
    if (dimsRaw !== undefined) {
      const dimensions = parseInt(dimsRaw, 10);
      return createOpenAIEmbeddingProvider({ model, apiKey, dimensions });
    }
    return createOpenAIEmbeddingProvider({ model, apiKey });
  }

  if (providerKind === "voyage") {
    const apiKey = process.env.VOYAGE_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "YAKCC_EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY to be set",
      );
    }
    const model = process.env.YAKCC_EMBEDDING_MODEL ?? "voyage-code-2";
    return createVoyageEmbeddingProvider({ model, apiKey });
  }

  if (providerKind === "openai-compatible") {
    const baseUrl = process.env.YAKCC_EMBEDDING_BASE_URL ?? "";
    if (!baseUrl) {
      throw new Error(
        "YAKCC_EMBEDDING_PROVIDER=openai-compatible requires YAKCC_EMBEDDING_BASE_URL to be set",
      );
    }
    const model = process.env.YAKCC_EMBEDDING_MODEL ?? "";
    if (!model) {
      throw new Error(
        "YAKCC_EMBEDDING_PROVIDER=openai-compatible requires YAKCC_EMBEDDING_MODEL to be set",
      );
    }
    const dimRaw = process.env.YAKCC_EMBEDDING_DIMENSION ?? "";
    if (!dimRaw) {
      throw new Error(
        "YAKCC_EMBEDDING_PROVIDER=openai-compatible requires YAKCC_EMBEDDING_DIMENSION to be set",
      );
    }
    const dimension = parseInt(dimRaw, 10);
    if (Number.isNaN(dimension) || dimension <= 0) {
      throw new Error(
        `YAKCC_EMBEDDING_DIMENSION must be a positive integer, got: ${dimRaw}`,
      );
    }
    const apiKey = process.env.YAKCC_EMBEDDING_API_KEY;
    if (apiKey !== undefined) {
      return createOpenAICompatibleEmbeddingProvider({ baseUrl, model, dimension, apiKey });
    }
    return createOpenAICompatibleEmbeddingProvider({ baseUrl, model, dimension });
  }

  throw new Error(
    `Unknown YAKCC_EMBEDDING_PROVIDER: "${providerKind}". ` +
      `Valid values: local, openai, voyage, openai-compatible`,
  );
}
