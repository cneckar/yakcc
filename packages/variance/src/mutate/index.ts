// SPDX-License-Identifier: MIT
// Barrel for the mutation-testing gate module.
export type { Mutant, SurvivorInfo, SurvivorReason, MutationResult, MutationInput, MutationOptions } from "./types.js";
export { ALL_OPERATORS, generateMutants, resetMutantId } from "./operators.js";
export {
  clearMutationCache,
  extractFuncName,
  hasImplReference,
  stripTypes,
  createMutantFn,
  prepareTestScript,
  executeMutantTest,
  selectMutants,
  runMutationTesting,
} from "./run.js";
