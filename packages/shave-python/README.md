# @yakcc/shave-python

Python raise adapter — shaves Python functions to the TS-subset IR (WI-782, ADR Q2).

**Status:** scaffolding only (slice 1 of 4). The subprocess wrapper and JSON-AST contract are in place; AST → IR mapping (slice 2), purity inference (slice 3), and end-to-end raise (slice 4) are upcoming.

## Slice plan

1. **Slice 1 (this scaffold):** package layout, `libcst-parser.ts` subprocess wrapper, JSON-AST contract, mock-based tests (no Python runtime required in CI)
2. **Slice 2:** AST mapping table → emit pure raise pipeline (per [ADR Q2](../../docs/archive/developer/adr/polyglot-architecture.md#q2--raise-contract-per-language))
3. **Slice 3:** purity inference via `pyright`, snake_case ↔ camelCase normalization
4. **Slice 4:** error taxonomy (`CannotRaiseToIRError`, `AmbiguousPurityError` from `@yakcc/contracts` per #780), integration test against the closer-parity corpus, CI Python provisioning

## Runtime requirements (post-slice-4)

- Python 3.10 or newer
- `pip install libcst pyright` available on `PATH`

The subprocess wrapper invokes `python3 scripts/libcst-parse.py`; if Python is missing or `libcst` is not installed, the wrapper throws `AdapterSubprocessError` with a remediation hint. Tests in this slice mock the subprocess so the suite runs in pure-Node environments.

## See also

- Parent design: [polyglot architecture ADR](../../docs/archive/developer/adr/polyglot-architecture.md)
- IR envelope spec: [`packages/ir/docs/ir-envelope.md`](../ir/docs/ir-envelope.md) (#780)
- Proof emitter (Python hypothesis): [`packages/contracts/src/proof-emitters/hypothesis.ts`](../contracts/src/proof-emitters/hypothesis.ts) (#781)
