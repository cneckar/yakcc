// SPDX-License-Identifier: MIT
/**
 * Static intent extraction — TypeScript Compiler API + JSDoc parser.
 *
 * @decision DEC-INTENT-STRATEGY-001
 * @title Strategy axis on ExtractIntentContext; "static" as default
 * @status accepted
 * @rationale
 *   The intent-extraction pipeline had exactly one cloud LLM dependency.
 *   Replacing it with a local TypeScript-Compiler-API + JSDoc parser achieves
 *   behavior-equivalent output (same IntentCard shape, same validateIntentCard
 *   runs) for the parts that matter (cache key, schema, validator) while
 *   eliminating the Anthropic round-trip (~1-3s/call) in favor of in-process
 *   AST parsing (~5ms/call). The "static" strategy is the new default because:
 *   (a) Yakcc's identity is "deterministic, content-addressed, local-first";
 *   (b) the LLM was only used to write human-readable documentation fields
 *       (behavior, param descriptions) into the IntentCard, not to influence
 *       slicing, matching, or content-addressing;
 *   (c) WI-016 (AI property-test corpus) may depend on the existing client
 *       surface — preserving the "llm" path behind strategy: "llm" is cheap
 *       insurance. The LLM path is entirely unchanged.
 *
 * @decision DEC-INTENT-STATIC-002
 * @title JSDoc tag vocabulary — Eiffel/JML lineage for preconditions/postconditions
 * @status accepted
 * @rationale
 *   Tag set: @param, @returns/@return, @requires, @ensures, @throws/@throw/
 *   @exception, @remarks, @note, @example.
 *   @requires / @ensures chosen for Eiffel/JML / Code Contracts / SPARK lineage:
 *   unambiguous, not claimed by tsc's type-checking machinery, and directly
 *   maps to the IntentCard's preconditions/postconditions arrays without
 *   any ambiguity. @pre/@post were rejected as they clash with some doc tooling.
 *
 * @decision DEC-INTENT-STATIC-003
 * @title Type extraction depth: source-text only via getTypeNode()?.getText()
 * @status accepted
 * @rationale
 *   We use param.getTypeNode()?.getText() rather than the type-checker's
 *   resolved type. Reasons:
 *   (a) shave's decompose() already parses with useInMemoryFileSystem:true and
 *       no lib loading (recursion.ts:282); a type-checked Program would need
 *       lib.d.ts and introduce TS-version nondeterminism;
 *   (b) parse cost without checker is ~5ms/call vs ~200ms/call with full lib
 *       resolution;
 *   (c) the "unknown" sentinel is the established convention in the LLM prompt
 *       (prompt.ts:33) and is accepted by validateIntentCard.
 */

import { Node, Project, type SourceFile } from "ts-morph";
import { pickPrimaryDeclaration } from "./static-pick.js";
import type { IntentParam } from "./types.js";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Envelope fields that staticExtract() embeds into the returned card.
 * These match the fields that extractIntent() assembles after the API call.
 */
export interface StaticExtractEnvelope {
  readonly sourceHash: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly extractedAt: string;
}

/**
 * Extract behavioral intent from a unit of TypeScript/JavaScript source using
 * the TypeScript Compiler API and JSDoc parsing.
 *
 * Returns an `unknown` value that the caller must pass through
 * `validateIntentCard()` — identical to the LLM path's post-processing step,
 * so the same validation invariants apply regardless of which path produced the
 * card.
 *
 * No Anthropic SDK is imported. No network calls are made. This function is
 * always offline-safe.
 *
 * @param unitSource - Raw source text of the candidate block.
 * @param envelope   - Pre-computed envelope fields (hash, version tags, timestamp).
 * @returns Unvalidated card object (call validateIntentCard before using).
 */
export function staticExtract(unitSource: string, envelope: StaticExtractEnvelope): unknown {
  // Parse with ts-morph using an in-memory virtual file system.
  // @decision DEC-INTENT-STATIC-003: no type-checker, no lib loading.
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: false,
      allowJs: true,
      noLib: true,
    },
  });
  const sourceFile = project.createSourceFile("__static_extract__.ts", unitSource);

  const primary = pickPrimaryDeclaration(sourceFile);

  // No declaration found — "source fragment" fallback
  if (primary === undefined) {
    const stmtCount = sourceFile.getStatements().length;
    const byteCount = unitSource.length;
    const behavior = `source fragment (${stmtCount} statements, ${byteCount} bytes)`;
    return {
      schemaVersion: 1,
      behavior,
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      notes: [],
      ...envelope,
    };
  }

  const jsdoc = extractJsDocFromNode(primary);
  const sig = extractSignatureInfo(primary, sourceFile);

  // Behavior field: JSDoc summary → signature string → fragment fallback
  const behavior =
    jsdoc.summary ?? sig.signatureString ?? buildFragmentFallback(sourceFile, unitSource);

  // Inputs: one entry per parameter
  const inputs: IntentParam[] = sig.params.map((p) => ({
    name: p.name,
    typeHint: p.typeHint,
    description: jsdoc.params.get(p.name) ?? "",
  }));

  // Outputs: always exactly one entry (matches LLM prompt convention, prompt.ts:33)
  // Exception: no-declaration fragment case already handled above.
  const outputs: IntentParam[] = [
    {
      name: "return",
      typeHint: sig.returnTypeHint,
      description: jsdoc.returns ?? "",
    },
  ];

  return {
    schemaVersion: 1,
    behavior,
    inputs,
    outputs,
    preconditions: jsdoc.preconditions,
    postconditions: jsdoc.postconditions,
    notes: jsdoc.notes,
    ...envelope,
  };
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

interface ParamInfo {
  name: string;
  typeHint: string;
}

interface SignatureInfo {
  params: ParamInfo[];
  returnTypeHint: string;
  signatureString: string | undefined;
}

/**
 * Extract the parameter list and return type from the primary declaration node.
 *
 * @decision DEC-INTENT-STATIC-003: source-text only, no type-checker.
 */
function extractSignatureInfo(node: Node, _sourceFile: SourceFile): SignatureInfo {
  // Resolve the actual function/arrow node from VariableStatement wrapper
  const funcNode = resolveFunctionNode(node);

  if (funcNode === undefined) {
    // ClassDeclaration method or other — try method extraction
    if (Node.isMethodDeclaration(node)) {
      return extractFromMethod(node);
    }
    return { params: [], returnTypeHint: "unknown", signatureString: undefined };
  }

  const params = extractParams(funcNode);
  const returnTypeHint = extractReturnType(funcNode);
  const signatureString = buildSignatureString(node, params, returnTypeHint);

  return { params, returnTypeHint, signatureString };
}

/**
 * Resolve a VariableStatement to its arrow/function initializer, or return
 * the node as-is if it's already a function/arrow/method.
 */
function resolveFunctionNode(node: Node): Node | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node)
  ) {
    return node;
  }

  if (Node.isVariableStatement(node)) {
    const decls = node.getDeclarationList().getDeclarations();
    if (decls.length === 0) return undefined;
    const init = decls[0]?.getInitializer();
    if (init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      return init;
    }
  }

  return undefined;
}

/** Extract params from a function/arrow node. */
function extractParams(node: Node): ParamInfo[] {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isFunctionExpression(node) &&
    !Node.isArrowFunction(node)
  ) {
    return [];
  }

  // ts-morph function-like nodes have getParameters()
  const params = (node as { getParameters(): unknown[] }).getParameters();
  return (params as Node[]).map((p) => {
    return {
      name: getParamName(p),
      // @decision DEC-INTENT-STATIC-003: source-text only
      typeHint: getParamTypeHint(p),
    };
  });
}

/** Extract parameter name, handling destructured and rest patterns. */
function getParamName(param: Node): string {
  // ParameterDeclaration has getNameNode()
  if (
    "getNameNode" in param &&
    typeof (param as { getNameNode(): unknown }).getNameNode === "function"
  ) {
    const nameNode = (param as { getNameNode(): Node }).getNameNode();
    if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
      return nameNode.getText();
    }
    // Check for rest parameter
    const isRest =
      "getDotDotDotToken" in param &&
      typeof (param as { getDotDotDotToken(): unknown }).getDotDotDotToken === "function" &&
      (param as { getDotDotDotToken(): unknown }).getDotDotDotToken() !== undefined;

    const baseName = nameNode.getText();
    return isRest ? `...${baseName}` : baseName;
  }
  return param.getText();
}

/** Extract the source-text type annotation from a parameter node. */
function getParamTypeHint(param: Node): string {
  if (
    "getTypeNode" in param &&
    typeof (param as { getTypeNode(): unknown }).getTypeNode === "function"
  ) {
    const typeNode = (param as { getTypeNode(): Node | undefined }).getTypeNode();
    return typeNode?.getText() ?? "unknown";
  }
  return "unknown";
}

/** Extract return type hint from a function-like node. */
function extractReturnType(node: Node): string {
  if (
    "getReturnTypeNode" in node &&
    typeof (node as { getReturnTypeNode(): unknown }).getReturnTypeNode === "function"
  ) {
    const rtNode = (node as { getReturnTypeNode(): Node | undefined }).getReturnTypeNode();
    if (rtNode !== undefined) {
      const text = rtNode.getText();
      if (text === "void" || text === "never") return "void";
      return text;
    }
  }
  // No return type annotation
  return "unknown";
}

/** Extract signature info from a MethodDeclaration. */
function extractFromMethod(method: Node): SignatureInfo {
  const params: ParamInfo[] = [];
  if (
    "getParameters" in method &&
    typeof (method as { getParameters(): unknown[] }).getParameters === "function"
  ) {
    for (const p of (method as { getParameters(): Node[] }).getParameters()) {
      params.push({
        name: getParamName(p),
        typeHint: getParamTypeHint(p),
      });
    }
  }
  const returnTypeHint = extractReturnType(method);
  const methodName =
    "getName" in method && typeof (method as { getName(): unknown }).getName === "function"
      ? ((method as { getName(): string | undefined }).getName() ?? "method")
      : "method";
  const paramNames = params.map((p) => p.name).join(", ");
  const signatureString = `method ${methodName}(${paramNames}) -> ${returnTypeHint}`;
  return { params, returnTypeHint, signatureString };
}

/**
 * Build the deterministic signature string used as the `behavior` fallback.
 *
 * Format: "<async? > <kind> <name>(<paramNames>) -> <returnTypeText>"
 * e.g. "function add(a, b) -> number"
 *      "async arrow const fetch(url) -> Promise<Response>"
 *
 * @decision DEC-INTENT-STATIC-BEHAVIOR-COLLAPSE-001
 * title: Collapse whitespace in buildSignatureString to prevent newlines in behavior
 * status: decided
 * rationale:
 *   The IntentCard schema invariant requires that the `behavior` field contains
 *   no newline characters (validateIntentCard line 142). When a function has a
 *   multi-line inline return-type annotation (e.g. `function f(): {\n  settings:
 *   ClaudeSettings;\n  alreadyInstalled: boolean;\n}`), extractReturnType()
 *   returns rtNode.getText() verbatim — including the literal newlines from the
 *   source. This propagates a `\n` into the behavior fallback string, causing
 *   IntentCardSchemaError at bootstrap time (issue #350, file 5).
 *
 *   Fix: pass the assembled signature string through collapseWhitespace() before
 *   returning. This is the single chokepoint: all branches (FunctionDeclaration,
 *   VariableStatement, FunctionExpression, ArrowFunction, anonymous) feed through
 *   one return site per branch, and wrapping the whole output makes it impossible
 *   for any future branch to introduce a newline accidentally.
 *
 *   collapseWhitespace() replaces all whitespace sequences (including \n, \r,
 *   \t, multiple spaces) with a single space and trims. A multi-line type like
 *   `{\n  settings: ClaudeSettings;\n  alreadyInstalled: boolean;\n}` becomes
 *   `{ settings: ClaudeSettings; alreadyInstalled: boolean; }` — schema-valid
 *   and human-readable.
 * alternatives:
 *   A (refactor source to named type aliases): producer-side fix is
 *     invariant-preserving by construction; source refactors would only fix
 *     specific call sites and leave the schema violation latent for future
 *     multi-line annotations.
 *   B (wrap only extractReturnType output): fixes today's case but misses
 *     newlines that could appear via getParamTypeHint in future.
 * consequences:
 *   - behavior fallback strings from multi-line type annotations now pass
 *     validateIntentCard; the schema invariant is producer-side enforced.
 *   - Collapse is lossy for formatting but lossless for information content;
 *     the 200-char truncation downstream is unchanged.
 *   - Compatible with WI-V2-09 byte-identical bootstrap (deterministic output).
 *   (#350, file 5)
 */
function buildSignatureString(node: Node, params: ParamInfo[], returnTypeHint: string): string {
  const paramNames = params.map((p) => p.name).join(", ");

  // Determine kind string and name
  let raw: string;

  if (Node.isFunctionDeclaration(node)) {
    const isAsync = node.isAsync();
    const name = node.getName() ?? "anonymous";
    const asyncPfx = isAsync ? "async " : "";
    raw = `${asyncPfx}function ${name}(${paramNames}) -> ${returnTypeHint}`;
  } else if (Node.isVariableStatement(node)) {
    // Resolve the arrow/function initializer for async detection
    const decls = node.getDeclarationList().getDeclarations();
    const firstDecl = decls[0];
    const varName = firstDecl?.getName() ?? "anonymous";
    const init = firstDecl?.getInitializer();
    const isAsync =
      init !== undefined &&
      "isAsync" in init &&
      typeof (init as { isAsync(): boolean }).isAsync === "function" &&
      (init as { isAsync(): boolean }).isAsync();
    const asyncPfx = isAsync ? "async " : "";

    const kindStr =
      init !== undefined && Node.isArrowFunction(init) ? "arrow const" : "function const";
    raw = `${asyncPfx}${kindStr} ${varName}(${paramNames}) -> ${returnTypeHint}`;
  } else if (Node.isFunctionExpression(node)) {
    const isAsync = node.isAsync();
    const name = node.getName() ?? "anonymous";
    const asyncPfx = isAsync ? "async " : "";
    raw = `${asyncPfx}function ${name}(${paramNames}) -> ${returnTypeHint}`;
  } else if (Node.isArrowFunction(node)) {
    const isAsync = node.isAsync();
    const asyncPfx = isAsync ? "async " : "";
    raw = `${asyncPfx}arrow(${paramNames}) -> ${returnTypeHint}`;
  } else {
    raw = `anonymous(${paramNames}) -> ${returnTypeHint}`;
  }

  // DEC-INTENT-STATIC-BEHAVIOR-COLLAPSE-001: collapse whitespace so that
  // multi-line return-type annotations (e.g. `{ settings: T;\n  flag: boolean }`)
  // never introduce newlines into the behavior field.
  return collapseWhitespace(raw);
}

/** Fragment fallback behavior string when there's no declaration. */
function buildFragmentFallback(sourceFile: SourceFile, src: string): string {
  const stmtCount = sourceFile.getStatements().length;
  return `source fragment (${stmtCount} statements, ${src.length} bytes)`;
}

// ---------------------------------------------------------------------------
// JSDoc extraction
// ---------------------------------------------------------------------------

interface JsDocInfo {
  summary: string | undefined;
  params: Map<string, string>;
  returns: string | undefined;
  preconditions: string[];
  postconditions: string[];
  notes: string[];
}

/**
 * Extract structured JSDoc fields from a node.
 *
 * @decision DEC-INTENT-STATIC-002: tag vocabulary.
 *
 * Critical: On `const f = () => ...`, JSDoc attaches to the VariableStatement,
 * NOT the inner ArrowFunction. This function accepts any Node and calls
 * getJsDocs() on it — the caller passes the VariableStatement (not the inner
 * arrow) so JSDoc is found correctly. See DEC-INTENT-STATIC-001.
 */
function extractJsDocFromNode(node: Node): JsDocInfo {
  const result: JsDocInfo = {
    summary: undefined,
    params: new Map(),
    returns: undefined,
    preconditions: [],
    postconditions: [],
    notes: [],
  };

  if (
    !("getJsDocs" in node && typeof (node as { getJsDocs(): unknown }).getJsDocs === "function")
  ) {
    return result;
  }

  const jsDocs = (node as { getJsDocs(): unknown[] }).getJsDocs();

  for (const docRaw of jsDocs) {
    const doc = docRaw as Node;
    if (!Node.isJSDoc(doc)) continue;

    // Summary: first sentence of the description
    const descNode = doc.getDescription();
    if (
      result.summary === undefined &&
      typeof descNode === "string" &&
      descNode.trim().length > 0
    ) {
      result.summary = extractFirstSentence(descNode);
    }

    // Tags
    for (const tag of doc.getTags()) {
      const tagName = tag.getTagName();
      // Tag text (everything after the tag name on that line and continuation lines)
      const tagText = getTagBody(tag);

      switch (tagName) {
        case "param": {
          const { paramName, body } = parseParamTag(tag);
          if (paramName !== "" && !result.params.has(paramName)) {
            result.params.set(paramName, body);
          }
          break;
        }

        case "returns":
        case "return":
          if (result.returns === undefined && tagText.length > 0) {
            result.returns = collapseWhitespace(tagText);
          }
          break;

        case "requires":
          if (tagText.length > 0) {
            result.preconditions.push(collapseWhitespace(tagText));
          }
          break;

        case "ensures":
          if (tagText.length > 0) {
            result.postconditions.push(collapseWhitespace(tagText));
          }
          break;

        case "throws":
        case "throw":
        case "exception":
          if (tagText.length > 0) {
            result.notes.push(`throws: ${collapseWhitespace(tagText)}`);
          }
          break;

        case "remarks":
          if (tagText.length > 0) {
            result.notes.push(`remarks: ${collapseWhitespace(tagText)}`);
          }
          break;

        case "example":
          if (tagText.length > 0) {
            result.notes.push(`example: ${collapseWhitespace(tagText)}`);
          }
          break;

        case "note":
          if (tagText.length > 0) {
            result.notes.push(collapseWhitespace(tagText));
          }
          break;

        default:
          // Unknown tag — skip
          break;
      }
    }
  }

  return result;
}

/** Parse a @param tag to extract the parameter name and description body. */
function parseParamTag(tag: Node): { paramName: string; body: string } {
  // ts-morph JSDocParameterTag has getNameNode() and getComment()
  if (
    "getNameNode" in tag &&
    typeof (tag as { getNameNode(): unknown }).getNameNode === "function"
  ) {
    const nameNode = (tag as { getNameNode(): Node | undefined }).getNameNode();
    if (nameNode !== undefined) {
      const paramName = nameNode.getText().replace(/^\.\.\./, "");
      const comment = getTagBody(tag);
      // Strip the param name from the beginning of the comment if present
      const stripped = comment.replace(new RegExp(`^${escapeRegex(paramName)}\\s*`), "");
      return { paramName, body: collapseWhitespace(stripped) };
    }
  }

  // Fallback: parse the raw text " paramName description"
  const raw = getTagBody(tag);
  const match = /^(\S+)\s*(.*)$/s.exec(raw);
  if (match !== null) {
    const paramName = (match[1] ?? "").replace(/^\.\.\./, "");
    return { paramName, body: collapseWhitespace(match[2] ?? "") };
  }
  return { paramName: "", body: "" };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace (newlines, tabs, multiple spaces) to single spaces and trim. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extract the first sentence from a JSDoc description.
 *
 * "First sentence" is the text up to the first `.`, `!`, or `?` followed by
 * whitespace (or end of string), collapsed and truncated to 197 chars + "...".
 */
function extractFirstSentence(description: string): string {
  const collapsed = collapseWhitespace(description);
  const match = /^(.*?[.!?])(?:\s|$)/s.exec(collapsed);
  const sentence = match !== null ? (match[1] ?? collapsed) : collapsed;
  if (sentence.length <= 200) return sentence;
  return `${sentence.slice(0, 197)}...`;
}

/** Get the body text of a JSDoc tag (everything after the tag name). */
function getTagBody(tag: Node): string {
  if ("getComment" in tag && typeof (tag as { getComment(): unknown }).getComment === "function") {
    const comment = (tag as { getComment(): string | undefined }).getComment();
    return typeof comment === "string" ? comment.trim() : "";
  }
  // Fallback: getText() and strip the @tagname prefix
  const text = tag.getText();
  const m = /^@\w+\s*(.*)$/s.exec(text);
  return m !== null ? (m[1] ?? "").trim() : "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
