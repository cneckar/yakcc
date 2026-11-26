# L2 over the corpus (#1421 slice 7)

`node packages/verify-l2/scripts/measure-corpus.mjs` writes
[`corpus-bootstrap.json`](corpus-bootstrap.json). This file is the run of 2026-11-26, with encoder
`verify-l2/3`, over `bootstrap/yakcc.registry.sqlite` (4,904 blocks) and the DUC corpus sample
(61 whole functions, `packages/duc/src/__fixtures__/corpus-sample.json`).

## What it measures

- **Contract coverage:** blocks whose spec has pre- or postconditions L2 could check.
- **The fragment:** whether each block's implementation encodes, and if not, the first construct
  refused. Parameters are taken as numbers here, so this measures the operations, not the
  declared types.
- **The pipeline:** for blocks with a number/boolean signature, verification of an automatic
  property: no NaN result for NaN-free number inputs.

## Results

| | Blocks |
|---|---|
| In the bootstrap registry | 4,904 |
| With a postcondition | **0** |
| With a precondition | 0 |
| With a number/boolean signature | 7 |
| With no result (shaved statement fragments, not functions) | 4,644 |
| Not liftable | 38 |
| Inside the fragment | 2 (both scalar) |

**DUC corpus sample:** of 61 functions, the 3 with number/boolean arguments are all inside the
fragment. The other 58 take strings, arrays or objects.

**First refusal over the registry**, in order:

| Construct | Blocks |
|---|---|
| a call of something not supplied | 1,163 |
| module statements (`declares:`) | 748 |
| closures | 202 |
| `undefined` | 200 |
| string literals | 177 |
| `.length` | 125 |
| indexing | 72 |
| `.push` | 65 |

The sample's refusals are almost all strings (`.replace`, `.charCodeAt`, `.length`, `.slice`,
templates), object fields and arrays.

**The automatic property on the two scalar blocks:**
- `function-cosineDistanceToCombi…`: proven.
- `function-add-a-b-number…` (`a + b`): disproven at `a = Infinity, b = -Infinity`, which gives
  NaN. The replay confirms it.

## What it means

1. **L2 has nothing to prove in today's corpus,** because no spec has conditions. The shaver
   writes none, and the bootstrap specs are signatures and prose. The first lever is contracts,
   not the encoder: postconditions from property tests, from the proof-spec emitters, or written
   by the model that composes, as B12's query cards already write examples.
2. **The registry's blocks are mostly fragments.** L2 is defined on function-level atoms, so
   measure it on those: the DUC sample, and the function atoms the compose-by-reference path
   serves.
3. **The fragment's next steps, by this measure:**
   - strings: UTF-16 code-unit sequences (`length`, `charCodeAt`, `slice`, `+`, `===`), as SMT
     sequences of 16-bit vectors;
   - arrays of numbers;
   - records of numbers and booleans.

   Calls of supplied callees already work; they need the registry to resolve links to proven
   callees.
