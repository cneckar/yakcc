// TypeScript's own compiler, run natively (#1370): typescript.js (its module function unwrapped,
// 5,376 statements) built by the native toolchain; each argument a TypeScript source, its
// transpileModule output printed as JSON, one line each.
const ts = require("typescript");
for (const text of process.argv.slice(2)) {
  const out = ts.transpileModule(text, { compilerOptions: { target: 99, module: 99 } });
  console.log(JSON.stringify(out.outputText));
}
