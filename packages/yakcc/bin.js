#!/usr/bin/env node
// Unscoped alias: forward to @yakcc/cli's bin.
// Using ESM dynamic import preserves stdio, signals, and process.argv handling
// without a subprocess boundary.
await import("@yakcc/cli/dist/bin.js");
