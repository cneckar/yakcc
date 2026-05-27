// SPDX-License-Identifier: MIT
// @decision DEC-MUTATE-OPS-001
// title: Text-based mutation operators for the TypeScript strict-subset IR
// status: decided
// rationale:
//   Atom implementations are valid TypeScript strict-subset code. Text-based
//   (regex / string) operators cover the ~20 operator categories identified in
//   mutation-testing literature (Stryker, Pitest) without requiring a full
//   TypeScript AST parser in the @yakcc/variance leaf package.
//   Each operator returns ALL non-overlapping matches in the source so callers
//   can select a random or deterministic subset when truncating to maxMutants.

import type { Mutant } from "./types.js";

// ---------------------------------------------------------------------------
// Operator definition
// ---------------------------------------------------------------------------

/** A mutation operator: given source text, returns all applicable mutants. */
export type MutationOperatorFn = (source: string) => readonly Mutant[];

export interface MutationOperator {
  readonly name: string;
  readonly apply: MutationOperatorFn;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let _mutantId = 0;

/** Reset the global mutant ID counter (for deterministic tests). */
export function resetMutantId(): void {
  _mutantId = 0;
}

function lineCol(source: string, index: number): { line: number; col: number } {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  const line = lines.length;
  // split("\n") always returns at least one element; the last element is always a string.
  const col = (lines[lines.length - 1] as string).length + 1;
  return { line, col };
}

function makeMutant(
  source: string,
  matchIndex: number,
  matchLen: number,
  replacement: string,
  operatorName: string,
  found: string,
): Mutant {
  const { line, col } = lineCol(source, matchIndex);
  const mutatedSource =
    source.slice(0, matchIndex) + replacement + source.slice(matchIndex + matchLen);
  return {
    id: ++_mutantId,
    originalSource: source,
    mutatedSource,
    operatorName,
    description: `${operatorName}: replaced ${JSON.stringify(found)} with ${JSON.stringify(replacement)} at ${line}:${col}`,
    line,
    col,
  };
}

/**
 * Build a MutationOperator from a regex pattern and a replacement string/function.
 * The pattern must NOT use the 'g' flag — this function adds it internally.
 */
function tokenOperator(
  name: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...groups: string[]) => string),
): MutationOperator {
  return {
    name,
    apply(source) {
      const mutants: Mutant[] = [];
      const global = new RegExp(pattern.source, `${pattern.flags}g`);
      let m = global.exec(source);
      while (m !== null) {
        const matched = m[0];
        const rep =
          typeof replacement === "function" ? replacement(matched, ...m.slice(1)) : replacement;
        mutants.push(makeMutant(source, m.index, matched.length, rep, name, matched));
        m = global.exec(source);
      }
      return mutants;
    },
  };
}

// ---------------------------------------------------------------------------
// Arithmetic operators (6)
// ---------------------------------------------------------------------------

// Replace binary + with - (but not unary + and not ++ or +=)
const arithPlusToMinus: MutationOperator = {
  name: "arith-plus-to-minus",
  apply(source) {
    const mutants: Mutant[] = [];
    // Match binary + not preceded/followed by + or = and not inside ++/+=
    const re = /(?<=[^\s+\-*/=<>!&|^~(,?:\n])\s*\+\s*(?=[^\s+=])/g;
    let m = re.exec(source);
    while (m !== null) {
      mutants.push(
        makeMutant(
          source,
          m.index,
          m[0].length,
          m[0].replace("+", "-"),
          "arith-plus-to-minus",
          m[0],
        ),
      );
      m = re.exec(source);
    }
    return mutants;
  },
};

const arithMinusToPlus = tokenOperator(
  "arith-minus-to-plus",
  // Binary minus: preceded by word char/digit/close paren/bracket, not --, -=
  /(?<=[a-zA-Z0-9_\])])\s*-\s*(?=[^-=>])/,
  (m) => m.replace("-", "+"),
);

const arithMulToDiv = tokenOperator("arith-mul-to-div", /(?<!\*)\*(?!\*|=)/, "/");
const arithDivToMul = tokenOperator("arith-div-to-mul", /\/(?!=|\/)/, "*");
const arithModToMul = tokenOperator("arith-mod-to-mul", /%(?!=)/, "*");
const arithPowToMul = tokenOperator("arith-pow-to-mul", /\*\*(?!=)/, "*");

// ---------------------------------------------------------------------------
// Comparison operators (8)
// ---------------------------------------------------------------------------

const cmpStrictEqToStrictNeq = tokenOperator("cmp-stricteq-to-strictneq", /===/, "!==");
const cmpStrictNeqToStrictEq = tokenOperator("cmp-strictneq-to-stricteq", /!==/, "===");
const cmpGtToGte = tokenOperator("cmp-gt-to-gte", />(?!=|>)/, ">=");
const cmpGteToGt = tokenOperator("cmp-gte-to-gt", />=/, ">");
const cmpLtToLte = tokenOperator("cmp-lt-to-lte", /<(?!=|<)/, "<=");
const cmpLteToLt = tokenOperator("cmp-lte-to-lt", /<=/, "<");
const cmpGtToLt = tokenOperator("cmp-gtlt", />(?!=|>)/, "<");
const cmpLtToGt = tokenOperator("cmp-ltgt", /<(?!=|<)/, ">");

// ---------------------------------------------------------------------------
// Boolean / logical operators (4)
// ---------------------------------------------------------------------------

const boolAndToOr = tokenOperator("bool-and-to-or", /&&/, "||");
const boolOrToAnd = tokenOperator("bool-or-to-and", /\|\|/, "&&");

// Strip leading `!` from a boolean expression (e.g. `!x` → `x`)
const boolNegationStrip: MutationOperator = {
  name: "bool-negation-strip",
  apply(source) {
    const mutants: Mutant[] = [];
    // Match `!` not followed by `=` and not `!!`
    const re = /!(?!=|!)/g;
    let m = re.exec(source);
    while (m !== null) {
      mutants.push(makeMutant(source, m.index, 1, "", "bool-negation-strip", "!"));
      m = re.exec(source);
    }
    return mutants;
  },
};

const boolTrueToFalse = tokenOperator("bool-true-to-false", /\btrue\b/, "false");

const boolFalseToTrue = tokenOperator("bool-false-to-true", /\bfalse\b/, "true");

// ---------------------------------------------------------------------------
// Control flow operators (3)
// ---------------------------------------------------------------------------

// Negate the condition in an if statement
const ctrlNegateIf: MutationOperator = {
  name: "ctrl-negate-if",
  apply(source) {
    const mutants: Mutant[] = [];
    // Match `if (` — negate the parenthesized condition by wrapping with `!(`
    const re = /\bif\s*\(/g;
    let m = re.exec(source);
    while (m !== null) {
      // Insert `!(` after `if (` and close with `)` before the original `)`
      // Simple approach: replace `if (` with `if (!(`
      const original = m[0];
      const replacement = original.replace(/\($/, "(!(");
      mutants.push(
        makeMutant(source, m.index, original.length, replacement, "ctrl-negate-if", original),
      );
      m = re.exec(source);
    }
    return mutants;
  },
};

// Replace `throw new XError(...)` with `return undefined as any`
const ctrlThrowToReturn: MutationOperator = {
  name: "ctrl-throw-to-return",
  apply(source) {
    const mutants: Mutant[] = [];
    const re = /\bthrow\s+new\s+[A-Za-z][A-Za-z0-9]*Error\s*\([^)]*\)/g;
    let m = re.exec(source);
    while (m !== null) {
      mutants.push(
        makeMutant(
          source,
          m.index,
          m[0].length,
          "return undefined as any",
          "ctrl-throw-to-return",
          m[0],
        ),
      );
      m = re.exec(source);
    }
    return mutants;
  },
};

// Replace `return <expr>` inside an if body with `return undefined`
const ctrlReturnToUndefined: MutationOperator = {
  name: "ctrl-return-to-undefined",
  apply(source) {
    const mutants: Mutant[] = [];
    // Match return with a non-trivial expression (not return; or return undefined)
    const re = /\breturn\s+(?!undefined\b|null\b|;)([^;{}\n]+)/g;
    let m = re.exec(source);
    while (m !== null) {
      const original = m[0];
      mutants.push(
        makeMutant(
          source,
          m.index,
          original.length,
          "return undefined",
          "ctrl-return-to-undefined",
          original,
        ),
      );
      m = re.exec(source);
    }
    return mutants;
  },
};

// ---------------------------------------------------------------------------
// Constants operators (5)
// ---------------------------------------------------------------------------

const constZeroToOne = tokenOperator(
  "const-zero-to-one",
  // Isolated 0 literal (not part of a larger number or string)
  /(?<![.\w])0(?![.\w])/,
  "1",
);

const constOneToZero = tokenOperator("const-one-to-zero", /(?<![.\w])1(?![.\w])/, "0");

// Replace empty string "" with " "
const constEmptyStringToSpace = tokenOperator("const-emptystr-to-space", /""/, '" "');

const constNullToUndefined = tokenOperator("const-null-to-undef", /\bnull\b/, "undefined");
const constUndefinedToNull = tokenOperator("const-undef-to-null", /\bundefined\b/, "null");

// ---------------------------------------------------------------------------
// Loop bounds operators (4)
// ---------------------------------------------------------------------------

// Inside a for loop condition, change < to <=
const loopLtToLte: MutationOperator = {
  name: "loop-lt-to-lte",
  apply(source) {
    const mutants: Mutant[] = [];
    // Find for(...; ...<...; ...) patterns
    const forRe = /\bfor\s*\([^)]*\)/g;
    let fm = forRe.exec(source);
    while (fm !== null) {
      const forStmt = fm[0];
      const ltIdx = forStmt.indexOf("<");
      if (ltIdx >= 0 && forStmt[ltIdx + 1] !== "=") {
        const absIdx = fm.index + ltIdx;
        mutants.push(makeMutant(source, absIdx, 1, "<=", "loop-lt-to-lte", "<"));
      }
      fm = forRe.exec(source);
    }
    return mutants;
  },
};

const loopLteToLt: MutationOperator = {
  name: "loop-lte-to-lt",
  apply(source) {
    const mutants: Mutant[] = [];
    const forRe = /\bfor\s*\([^)]*\)/g;
    let fm = forRe.exec(source);
    while (fm !== null) {
      const forStmt = fm[0];
      const lteIdx = forStmt.indexOf("<=");
      if (lteIdx >= 0) {
        const absIdx = fm.index + lteIdx;
        mutants.push(makeMutant(source, absIdx, 2, "<", "loop-lte-to-lt", "<="));
      }
      fm = forRe.exec(source);
    }
    return mutants;
  },
};

// Off-by-one on loop initializer: i = 0 → i = 1
const loopInitZeroToOne: MutationOperator = {
  name: "loop-init-zero-to-one",
  apply(source) {
    const mutants: Mutant[] = [];
    const forRe = /\bfor\s*\([^)]*\)/g;
    let fm = forRe.exec(source);
    while (fm !== null) {
      const forStmt = fm[0];
      // Find `= 0` in the init part (before first ;)
      const initPart = forStmt.slice(0, forStmt.indexOf(";"));
      const zeroIdx = initPart.search(/=\s*0(?![.\w])/);
      if (zeroIdx >= 0) {
        const absIdx = fm.index + zeroIdx + initPart.slice(zeroIdx).indexOf("0");
        mutants.push(makeMutant(source, absIdx, 1, "1", "loop-init-zero-to-one", "0"));
      }
      fm = forRe.exec(source);
    }
    return mutants;
  },
};

// Replace i++ with i-- in loop increment
const loopIncrToDecr = tokenOperator("loop-incr-to-decr", /\+\+(?=[;)\s])/, "--");

// ---------------------------------------------------------------------------
// Off-by-one in direct comparisons (2)
// ---------------------------------------------------------------------------

// n - 1 → n (drop the subtraction in a bound like `length - 1`)
const oboMinusOneToZero = tokenOperator(
  "obo-minus-one",
  /(?<=[a-zA-Z_$][a-zA-Z0-9_$.]*)\s*-\s*1(?![0-9])/,
  "",
);

// n + 1 → n (drop the addition)
const oboPlusOneToZero = tokenOperator(
  "obo-plus-one",
  /(?<=[a-zA-Z_$][a-zA-Z0-9_$.]*)\s*\+\s*1(?![0-9])/,
  "",
);

// ---------------------------------------------------------------------------
// Export: canonical operator set
// ---------------------------------------------------------------------------

export const ALL_OPERATORS: readonly MutationOperator[] = [
  arithPlusToMinus,
  arithMinusToPlus,
  arithMulToDiv,
  arithDivToMul,
  arithModToMul,
  arithPowToMul,
  cmpStrictEqToStrictNeq,
  cmpStrictNeqToStrictEq,
  cmpGtToGte,
  cmpGteToGt,
  cmpLtToLte,
  cmpLteToLt,
  cmpGtToLt,
  cmpLtToGt,
  boolAndToOr,
  boolOrToAnd,
  boolNegationStrip,
  boolTrueToFalse,
  boolFalseToTrue,
  ctrlNegateIf,
  ctrlThrowToReturn,
  ctrlReturnToUndefined,
  constZeroToOne,
  constOneToZero,
  constEmptyStringToSpace,
  constNullToUndefined,
  constUndefinedToNull,
  loopLtToLte,
  loopLteToLt,
  loopInitZeroToOne,
  loopIncrToDecr,
  oboMinusOneToZero,
  oboPlusOneToZero,
];

/**
 * Generate all candidate mutants for a given source using all operators.
 * Deduplicated by (operatorName, line, col) so operators don't produce
 * identical mutations at the same site.
 */
export function generateMutants(source: string): readonly Mutant[] {
  resetMutantId();
  const seen = new Set<string>();
  const all: Mutant[] = [];
  for (const op of ALL_OPERATORS) {
    for (const mutant of op.apply(source)) {
      const key = `${mutant.operatorName}:${mutant.line}:${mutant.col}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(mutant);
      }
    }
  }
  return all;
}
