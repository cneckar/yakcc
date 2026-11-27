// TypeScript's own compiler, run natively (#1370): typescript.js (its module function unwrapped,
// 5,376 statements) built by the native toolchain.
// - Each argument a TypeScript source: its transpileModule output printed as JSON, one line each.
// - `--check <lib name> <lib text> … -- <file name> <file text> …` (a lib's text in parts, each
//   after a name of "+"): a program over an in-memory
//   host (lib.es5.d.ts and its references given as arguments, as files are), type-checked and
//   emitted; its diagnostics, each variable's type and the emitted files printed as JSON.
const ts = require("typescript");
const args = process.argv.slice(2);
if (args[0] === "--check") {
  const files = {};
  const roots = [];
  let i = 1;
  let last = "";
  // A file's text may come in parts (an argument is at most 128 KiB): a name of "+" continues it.
  for (; args[i] !== "--"; i += 2) {
    if (args[i] !== "+") last = `/lib/${args[i]}`;
    files[last] = (args[i] === "+" ? files[last] : "") + args[i + 1];
  }
  for (i++; i < args.length; i += 2) {
    files[args[i]] = args[i + 1];
    roots.push(args[i]);
  }
  const emitted = {};
  const host = {
    getSourceFile: (f, lang) =>
      files[f] !== undefined ? ts.createSourceFile(f, files[f], lang) : undefined,
    getDefaultLibFileName: () => "/lib/lib.es5.d.ts",
    getDefaultLibLocation: () => "/lib",
    writeFile: (f, text) => {
      emitted[f] = text;
    },
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (f) => files[f] !== undefined,
    readFile: (f) => files[f],
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    directoryExists: () => true,
  };
  const options = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    lib: ["lib.es5.d.ts"],
  };
  const program = ts.createProgram([roots[0]], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
    const at = d.file
      ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
      : "";
    return `${at}TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " | ")}`;
  });
  program.emit();
  const checker = program.getTypeChecker();
  const types = [];
  for (const root of roots) {
    const sf = program.getSourceFile(root);
    ts.forEachChild(sf, function visit(n) {
      if (ts.isVariableDeclaration(n))
        types.push(
          `${n.name.getText(sf)}: ${checker.typeToString(checker.getTypeAtLocation(n.name))}`,
        );
      ts.forEachChild(n, visit);
    });
  }
  console.log(JSON.stringify({ diagnostics, types, emitted }));
} else
  for (const text of args) {
    const out = ts.transpileModule(text, { compilerOptions: { target: 99, module: 99 } });
    console.log(JSON.stringify(out.outputText));
  }
