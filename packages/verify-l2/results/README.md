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

## With strings (encoder `verify-l2/4`, the same day)

| | Before | With strings |
|---|---|---|
| Registry blocks with an encodable signature (number, boolean, string) | 7 | 46 |
| Registry blocks inside the fragment | 2 | 9 |
| DUC sample functions whose arguments are numbers, booleans or strings | 3 | 35 |
| DUC sample functions inside the fragment | 3 | 4 |

**The sample's next refusals:**

| Construct | Functions |
|---|---|
| `s[i]` (a string or `undefined`) | 7 |
| `.replace` | 6 |
| closures | 5 |
| `.length` of arrays | 4 |
| a number converted to a string | 3 |

## With arrays and `undefined` (encoder `verify-l2/5`)

Every node is now encoded (an unused write was missed before), so a block's first refusal is the
first node the encoder cannot model, in graph order. That reorders the registry's refusal list:
module statements 1,444, closures 572, `for…of` 122, `await` 99.

| | With strings | With arrays |
|---|---|---|
| Registry blocks with an encodable signature | 46 | 49 |
| Registry blocks inside the fragment | 9 | 10 |
| DUC sample functions with encodable argument types | 35 | 37 |
| DUC sample functions inside the fragment | 4 | 5 |

**The sample's next refusals:**

| Construct | Functions |
|---|---|
| `.length` (of values whose type the sample does not give) | 14 |
| closures | 8 |
| `null` and other literals | 4 |
| `.kind` (object fields) | 3 |
| `.replace` | 3 |
| a number converted to a string | 3 |

Next: records (object fields), closures as callbacks (`map`, `filter`), `null`.

## With records (encoder `verify-l2/6`)

Records do not change these numbers:
- no registry spec declares an object type L2 reads;
- the sample's remaining `.kind` reads are of untyped (`any`) AST nodes.

The sample's functions with argument types L2 reads go from 37 to 39 (record kinds); 5 are inside
the fragment. Callbacks are not encoded (see the package README for why).
