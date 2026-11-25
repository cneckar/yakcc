# @yakcc/node-platform

Node's library, as the platform a shaved program runs on (#1329, #1331).

- `vendor/node-v22.23.5/lib/`: every builtin module of Node v22.23.5, extracted from the binary (`scripts/extract-node-lib.mjs`), under Node's license (`vendor/node-v22.23.5/LICENSE`). `manifest.json` lists the modules and the `internalBinding` members this Node exposes.
- `src/bindings.ts`: every binding the library names, classified as logic, os, runtime, data or later (DEC-DUC-NODE-BASE-SET-001).
- `src/shave-node.ts`: one module through the real shave pipeline, every atom judged by the shave's gate, with the module wrapper's names (`primordials`, `internalBinding`, `process`, …) bound.
