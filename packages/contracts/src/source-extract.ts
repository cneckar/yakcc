// SPDX-License-Identifier: MIT
/**
 * Shared TypeScript source-extraction primitives used by both:
 *   - packages/shave/src/intent/static-extract.ts  (atomize/storeBlock path)
 *   - packages/contracts/src/query-from-source.ts   (query enrichment path)
 *
 * @decision DEC-EMBED-QUERY-ENRICH-HELPER-001
 * @title Shared extraction primitive ensures byte-identical behavior/signature
 *        derivation on both atomize-side and query-side (OD-2 Option A).
 * @status accepted
 * @rationale
 *   The embedding asymmetry (#444 / #502 / #523) was caused partly by
 *   query-side callers deriving QueryIntentCard fields independently from how
 *   the atomize path (storeBlock) derives IntentCard fields from source. By
 *   factoring the extraction code into this shared module, any future
 *   improvement to extraction (e.g. a new @throws parser, rest-param handling)
 *   is automatically applied to BOTH paths, making extraction-asymmetry drift
 *   structurally harder to reintroduce.
 *
 *   Design decisions inherited from static-extract.ts:
 *   - DEC-INTENT-STATIC-003: source-text only via getTypeNode()?.getText()
 *     (no type-checker, no lib loading, ~5ms vs ~200ms).
 *   - DEC-INTENT-STATIC-002: JSDoc tag vocabulary (Eiffel/JML lineage).
 *   - DEC-INTENT-STATIC-BEHAVIOR-COLLAPSE-001: whitespace collapse in
 *     buildSignatureString prevents newlines in behavior field.
 *   - DEC-INTENT-STATIC-001: primary-declaration preference chain
 *     (re-implemented in source-pick.ts in this package).
 *
 * Dependencies: ts-morph only (already a contracts peer dependency).
 * No I/O. Deterministic. Pure.
 */

import { Node, type SourceFile } from "ts-morph";

// ---------------------------------------------------------------------------
// Exported primitive types
// ---------------------------------------------------------------------------

/**
 * A single extracted parameter: name + source-text type annotation.
 * Compatible with IntentParam.name/typeHint (shave) and
 * QueryTypeSignatureParam.name/type (contracts), but uses neutral field names
 * to avoid coupling to either package's schema.
 */
export interface ExtractedParam {
  /** Parameter name (or destructure pattern text, or "...rest"). */
  readonly name: string;
  /**
   * Source-text type annotation, e.g. "number", "readonly string[]", "T".
   * "unknown" when no annotation is present.
   * (DEC-INTENT-STATIC-003)
   */
  readonly typeAnnotation: string;
}

/**
 * Extracted signature info from a function-like declaration node.
 */
export interface ExtractedSignature {
  readonly params: readonly ExtractedParam[];
  readonly returnTypeAnnotation: string;
  /**
   * Deterministic signature string used as the behavior fallback when no
   * JSDoc summary is present.
   * e.g. "function add(a, b) -> number"
   * Undefined when the node has no function-like shape.
   */
  readonly signatureString: string | undefined;
}

/**
 * Structured JSDoc fields extracted from a declaration node.
 */
export interface ExtractedJsDoc {
  /** First sentence of the JSDoc description, or undefined if absent. */
  readonly summary: string | undefined;
  /** Map from param name to description text. */
  readonly params: ReadonlyMap<string, string>;
  /** @returns / @return description text, or undefined. */
  readonly returns: string | undefined;
  /** @requires precondition texts (in order). */
  readonly preconditions: readonly string[];
  /** @ensures postcondition texts (in order). */
  readonly postconditions: readonly string[];
  /** @throws / @throw / @exception description texts (with "throws: " prefix). */
  readonly throwDescriptions: readonly string[];
  /** @remarks / @example / @note annotation texts. */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Public API — signature extraction
// ---------------------------------------------------------------------------

/**
 * Extract the parameter list and return-type annotation from the primary
 * declaration node of a source file.
 *
 * @param node - The declaration node (may be FunctionDeclaration,
 *   VariableStatement, ArrowFunction, or MethodDeclaration).
 * @returns ExtractedSignature (empty params / "unknown" / undefined when
 *   the node has no function-like shape).
 */
export function extractSignatureFromNode(node: Node): ExtractedSignature {
  // Resolve the actual function/arrow node from VariableStatement wrapper.
  const funcNode = resolveFunctionNode(node);

  if (funcNode === undefined) {
    if (Node.isMethodDeclaration(node)) {
      return extractSignatureFromMethod(node);
    }
    return { params: [], returnTypeAnnotation: "unknown", signatureString: undefined };
  }

  const params = extractParams(funcNode);
  const returnTypeAnnotation = extractReturnType(funcNode);
  const signatureString = buildSignatureString(node, params, returnTypeAnnotation);

  return { params, returnTypeAnnotation, signatureString };
}

// ---------------------------------------------------------------------------
// Public API — JSDoc extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured JSDoc fields from a declaration node.
 *
 * Critical: On `const f = () => ...`, JSDoc attaches to the VariableStatement,
 * NOT the inner ArrowFunction. Always pass the VariableStatement here —
 * see DEC-INTENT-STATIC-001.
 *
 * Tag vocabulary (DEC-INTENT-STATIC-002):
 *   @param, @returns/@return, @requires, @ensures,
 *   @throws/@throw/@exception, @remarks, @example, @note.
 *
 * @param node - The declaration node to extract JSDoc from.
 * @returns ExtractedJsDoc (all arrays empty, fields undefined, when no JSDoc).
 */
export function extractJsDoc(node: Node): ExtractedJsDoc {
  const result: {
    summary: string | undefined;
    params: Map<string, string>;
    returns: string | undefined;
    preconditions: string[];
    postconditions: string[];
    throwDescriptions: string[];
    notes: string[];
  } = {
    summary: undefined,
    params: new Map(),
    returns: undefined,
    preconditions: [],
    postconditions: [],
    throwDescriptions: [],
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

    // Summary: first sentence of the description.
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
            result.throwDescriptions.push(collapseWhitespace(tagText));
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
          // Unknown tag — skip.
          break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API — named-function picker (for entryFunction option)
// ---------------------------------------------------------------------------

/**
 * Find an exported declaration node by name in a source file.
 *
 * Used by queryIntentCardFromSource when the caller specifies `entryFunction`.
 * Returns the VariableStatement for arrow-const declarations (JSDoc gotcha —
 * see DEC-INTENT-STATIC-001) or the FunctionDeclaration itself.
 *
 * @param sourceFile - Parsed ts-morph SourceFile.
 * @param name       - Name of the exported function/const to find.
 * @returns The matching Node or undefined if not found.
 */
export function findExportedDeclarationByName(
  sourceFile: SourceFile,
  name: string,
): Node | undefined {
  for (const stmt of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      if (stmt.getName() === name) return stmt;
    }
    if (Node.isVariableStatement(stmt)) {
      const decls = stmt.getDeclarationList().getDeclarations();
      if (decls[0]?.getName() === name) return stmt;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers — signature extraction
// ---------------------------------------------------------------------------

/**
 * Resolve a VariableStatement to its arrow/function initializer, or return
 * the node as-is if it's already a function/arrow node.
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
function extractParams(node: Node): ExtractedParam[] {
  if (
    !Node.isFunctionDeclaration(node) &&
    !Node.isFunctionExpression(node) &&
    !Node.isArrowFunction(node)
  ) {
    return [];
  }

  const params = (node as { getParameters(): unknown[] }).getParameters();
  return (params as Node[]).map((p) => ({
    name: getParamName(p),
    // DEC-INTENT-STATIC-003: source-text only.
    typeAnnotation: getParamTypeAnnotation(p),
  }));
}

/** Extract parameter name, handling destructured and rest patterns. */
function getParamName(param: Node): string {
  if (
    "getNameNode" in param &&
    typeof (param as { getNameNode(): unknown }).getNameNode === "function"
  ) {
    const nameNode = (param as { getNameNode(): Node }).getNameNode();
    if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
      return nameNode.getText();
    }
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
function getParamTypeAnnotation(param: Node): string {
  if (
    "getTypeNode" in param &&
    typeof (param as { getTypeNode(): unknown }).getTypeNode === "function"
  ) {
    const typeNode = (param as { getTypeNode(): Node | undefined }).getTypeNode();
    return typeNode?.getText() ?? "unknown";
  }
  return "unknown";
}

/** Extract return-type annotation from a function-like node. */
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
  return "unknown";
}

/** Extract signature info from a MethodDeclaration. */
function extractSignatureFromMethod(method: Node): ExtractedSignature {
  const params: ExtractedParam[] = [];
  if (
    "getParameters" in method &&
    typeof (method as { getParameters(): unknown[] }).getParameters === "function"
  ) {
    for (const p of (method as { getParameters(): Node[] }).getParameters()) {
      params.push({
        name: getParamName(p),
        typeAnnotation: getParamTypeAnnotation(p),
      });
    }
  }
  const returnTypeAnnotation = extractReturnType(method);
  const methodName =
    "getName" in method && typeof (method as { getName(): unknown }).getName === "function"
      ? ((method as { getName(): string | undefined }).getName() ?? "method")
      : "method";
  const paramNames = params.map((p) => p.name).join(", ");
  const signatureString = `method ${methodName}(${paramNames}) -> ${returnTypeAnnotation}`;
  return { params, returnTypeAnnotation, signatureString };
}

/**
 * Build the deterministic signature string used as the `behavior` fallback.
 *
 * Format: "<async? > <kind> <name>(<paramNames>) -> <returnType>"
 * e.g. "function add(a, b) -> number"
 *      "async arrow const fetch(url) -> Promise<Response>"
 *
 * DEC-INTENT-STATIC-BEHAVIOR-COLLAPSE-001: output is passed through
 * collapseWhitespace() so multi-line return-type annotations never produce
 * newlines in the behavior field.
 */
function buildSignatureString(
  node: Node,
  params: readonly ExtractedParam[],
  returnTypeAnnotation: string,
): string {
  const paramNames = params.map((p) => p.name).join(", ");
  let raw: string;

  if (Node.isFunctionDeclaration(node)) {
    const isAsync = node.isAsync();
    const name = node.getName() ?? "anonymous";
    const asyncPfx = isAsync ? "async " : "";
    raw = `${asyncPfx}function ${name}(${paramNames}) -> ${returnTypeAnnotation}`;
  } else if (Node.isVariableStatement(node)) {
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
    raw = `${asyncPfx}${kindStr} ${varName}(${paramNames}) -> ${returnTypeAnnotation}`;
  } else if (Node.isFunctionExpression(node)) {
    const isAsync = node.isAsync();
    const name = node.getName() ?? "anonymous";
    const asyncPfx = isAsync ? "async " : "";
    raw = `${asyncPfx}function ${name}(${paramNames}) -> ${returnTypeAnnotation}`;
  } else if (Node.isArrowFunction(node)) {
    const isAsync = node.isAsync();
    const asyncPfx = isAsync ? "async " : "";
    raw = `${asyncPfx}arrow(${paramNames}) -> ${returnTypeAnnotation}`;
  } else {
    raw = `anonymous(${paramNames}) -> ${returnTypeAnnotation}`;
  }

  // DEC-INTENT-STATIC-BEHAVIOR-COLLAPSE-001: collapse whitespace so that
  // multi-line return-type annotations never introduce newlines.
  return collapseWhitespace(raw);
}

// ---------------------------------------------------------------------------
// Internal helpers — JSDoc extraction
// ---------------------------------------------------------------------------

function parseParamTag(tag: Node): { paramName: string; body: string } {
  if (
    "getNameNode" in tag &&
    typeof (tag as { getNameNode(): unknown }).getNameNode === "function"
  ) {
    const nameNode = (tag as { getNameNode(): Node | undefined }).getNameNode();
    if (nameNode !== undefined) {
      const paramName = nameNode.getText().replace(/^\.\.\./, "");
      const comment = getTagBody(tag);
      const stripped = comment.replace(new RegExp(`^${escapeRegex(paramName)}\\s*`), "");
      return { paramName, body: collapseWhitespace(stripped) };
    }
  }

  const raw = getTagBody(tag);
  const match = /^(\S+)\s*(.*)$/s.exec(raw);
  if (match !== null) {
    const paramName = (match[1] ?? "").replace(/^\.\.\./, "");
    return { paramName, body: collapseWhitespace(match[2] ?? "") };
  }
  return { paramName: "", body: "" };
}

// ---------------------------------------------------------------------------
// Internal helpers — text utilities
// ---------------------------------------------------------------------------

/** Collapse whitespace (newlines, tabs, multiple spaces) to single spaces and trim. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extract the first sentence from a JSDoc description.
 *
 * "First sentence" is the text up to the first `.`, `!`, or `?` followed by
 * whitespace (or end of string), collapsed and truncated to 197 chars + "...".
 */
export function extractFirstSentence(description: string): string {
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
  const text = tag.getText();
  const m = /^@\w+\s*(.*)$/s.exec(text);
  return m !== null ? (m[1] ?? "").trim() : "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
