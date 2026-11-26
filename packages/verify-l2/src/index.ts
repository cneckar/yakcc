// SPDX-License-Identifier: Apache-2.0
/**
 * @yakcc/verify-l2: SMT proofs of an atom's pre- and postconditions over its DUC graph (#1421).
 */
export type {
  CounterexampleInput,
  L2Options,
  L2Report,
  Obligation,
  ObligationKind,
  Outcome,
  ThrowReport,
  Verdict,
} from "./verify.js";
export { ENCODER_VERSION, verifyL2 } from "./verify.js";
export type { Callee, L2Contract } from "./types.js";
export type { GoalObligation, L2Type, LoopInfo, ThrowSite } from "./encoder.js";
export { Encoder, loopsOf, sortOf, typeOf } from "./encoder.js";
export type { Sort, Term } from "./terms.js";
export {
  MATH_EXACT,
  PRELUDE,
  Unsupported,
  f64Bits,
  f64FromBits,
  f64Literal,
  mathCall,
  operation,
  truthy,
} from "./terms.js";
export type { SolverAnswer } from "./solver.js";
export { check, shutdownSolver, solverVersion } from "./solver.js";
export type { L2Recheck, L2Record } from "./record.js";
export {
  L2_RECORD_FORMAT,
  L2_THEORY,
  contractFromSpec,
  encodeL2Record,
  l2Artifact,
  l2Record,
  l2RecordHash,
  recheckL2,
} from "./record.js";
