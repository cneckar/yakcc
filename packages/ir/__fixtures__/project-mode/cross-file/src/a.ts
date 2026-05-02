// Fixture: cross-file/src/a.ts
// Purpose: exports a typed number constant for the cross-file import resolution test.
// The project-mode validator must resolve this from b.ts without a false-positive
// no-untyped-imports violation when loaded via tsconfig.

export const a: number = 1;
