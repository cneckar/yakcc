# Troubleshooting

Common failures, diagnostic steps, and fixes. Each entry follows the pattern: symptom → diagnostic command → fix → related issue.

If your problem is not here, [file an issue](https://github.com/cneckar/yakcc/issues/new?template=alpha-feedback.md). Include the output of `yakcc --version` and the last 10 lines of `~/.yakcc/telemetry/*.jsonl`.

---

## 1. `yakcc init` doesn't detect my IDE

**Symptom:** Running `yakcc init` completes without errors, but no hook appears in `.claude/settings.json` (Claude Code) or the equivalent Cursor settings file.

**Diagnostic:**

```sh
# Check whether the settings file exists and contains the yakcc entry
cat .claude/settings.json | grep -A 5 yakcc
```

**Fix:** Run the explicit hook installer after init:

```sh
yakcc hooks claude-code install [--target <dir>]
# or for Cursor:
yakcc hooks cursor install [--target <dir>]
```

Then restart the IDE. Re-running is idempotent — it will not create duplicate entries.

**Windows note:** On Windows, `yakcc init` may no-op the hook wiring step. This is tracked at [#385](https://github.com/cneckar/yakcc/issues/385). Use `yakcc hooks claude-code install` explicitly if `grep yakcc .claude/settings.json` returns nothing.

---

## 2. Claude Code doesn't fire the hook on Edit/Write/MultiEdit

**Symptom:** Claude Code sessions proceed but `~/.yakcc/telemetry/` stays empty or the telemetry file is not updated after edits.

**Diagnostic:**

```sh
# Confirm hook entry is present
grep -A 8 yakcc .claude/settings.json

# Confirm telemetry directory exists and has content
ls ~/.yakcc/telemetry/
tail -5 ~/.yakcc/telemetry/*.jsonl 2>/dev/null || echo "no telemetry yet"
```

**Fix:**

1. Verify the `PreToolUse` hook entry is present in `.claude/settings.json`. If not, run `yakcc hooks claude-code install`.
2. Restart Claude Code — hooks are read at process startup.
3. Confirm `yakcc hook-intercept` is on your PATH: `which yakcc` should resolve.

If the entry is present and Claude Code has been restarted but the telemetry file still does not appear, file an issue with the `settings.json` excerpt and your Claude Code version.

---

## 3. Registry seems empty after `yakcc init`

**Symptom:** `yakcc query "any query"` returns no results, or `yakcc search "anything"` returns nothing, immediately after running `yakcc init`.

**Explanation:** `yakcc init` deliberately does not auto-seed the registry (per `DEC-CLI-INIT-001`). An empty registry is correct initial state — you may only want your own project's atoms.

**Fix — option A (yakcc bootstrap corpus):**

```sh
yakcc seed --yakcc
```

Imports ~3,800 shaved atoms from yakcc's own source. One-time operation; idempotent.

**Fix — option B (minimal seed corpus):**

```sh
yakcc seed
```

Imports ~20 atoms covering a JSON integer-list parser. Good for verifying the pipeline end-to-end.

**Fix — option C (team registry):**

```sh
yakcc federation mirror --remote https://your-team-registry.example.com \
  --registry .yakcc/registry.sqlite
```

Confirm the import worked:

```sh
yakcc query "store a block by content address"
```

---

## 4. Every emission shows `outcome: "passthrough"`

**Symptom:** Telemetry shows `"outcome": "passthrough"` for every hook invocation, even after seeding the registry.

**Likely cause:** Embedding model mismatch. If yakcc was upgraded and the default embedding model changed (or the registry was built with a different model), the stored vectors cannot be compared to live query vectors.

**Diagnostic:**

```sh
tail -3 ~/.yakcc/telemetry/*.jsonl | jq .
# Look for: outcome: "passthrough", latencyMs very low (< 1ms) = registry not queried
```

**Fix:**

```sh
yakcc registry rebuild --path .yakcc/registry.sqlite
```

This regenerates all embedding vectors for the current default model (`bge-small-en-v1.5` per `DEC-EMBED-MODEL-DEFAULT-002`) without touching atom content. After rebuild, restart Claude Code.

---

## 5. `outcome: "synthesis-required"` for most emissions

**Symptom:** Telemetry mostly shows `"outcome": "synthesis-required"` — the registry has atoms but nothing matches your code.

**Explanation:** This is expected on a fresh install with a sparse corpus. The registry only knows atoms that have been shaved into it. Early sessions on your own codebase will see high synthesis-required rates; the ratio improves as your corpus grows.

**Steps to improve hit rate:**

1. Seed the yakcc bootstrap corpus if you haven't: `yakcc seed --yakcc`.
2. After Claude Code writes novel code you want to reuse, shave it: `yakcc shave src/my-utils.ts`.
3. The global registry peer (`yakcc.dev`) does not exist yet (tracked at [#371](https://github.com/cneckar/yakcc/issues/371)). When it lands, your default install gains a large shared corpus immediately.

---

## 6. Federation mirror fails with integrity error

**Symptom:** `yakcc federation mirror` exits with an integrity error like `BlockMerkleRoot mismatch` or `integrity check failed`.

**Explanation:** The peer returned bytes that do not match the advertised content-address. This is a correct and expected hard failure — the F1 integrity gate rejects tampered or corrupted transfers.

**Diagnostic:**

```sh
yakcc federation mirror --remote <peer-url> --registry .yakcc/registry.sqlite --verbose
# Look for: which block hash mismatches, which peer URL
```

**Fix:**

- If the peer is your own team server, the server may have a corrupt atom. Contact the peer operator and ask them to verify with `yakcc registry integrity-check`.
- If the peer is a third party, do not trust the registry. The integrity failure is a security signal, not a network hiccup.
- Retry is only safe after the peer has confirmed their registry is clean.

---

## 7. Bootstrap is slow

**Symptom:** `yakcc bootstrap` or `yakcc seed --yakcc` takes 30+ minutes when prior runs completed in ~5 minutes.

**Known cause:** The schema v9 write path has a performance regression tracked at [#377](https://github.com/cneckar/yakcc/issues/377). A fix is in flight.

**Workaround:**

```sh
# Check if a fix has shipped since you last pulled
git -C ~/.yakcc-cli pull
pnpm -C ~/.yakcc-cli -r build
```

If the regression persists after pulling, check issue [#377](https://github.com/cneckar/yakcc/issues/377) for the latest status and attach your timing data.

**Incremental shave caching** (daily-UX improvement) is on the roadmap at [#363](https://github.com/cneckar/yakcc/issues/363). Until it lands, large codebases pay the full traversal cost every run.

---

## 8. Windows-specific issues

**`yakcc init` produces no output / no-ops on Windows:**

`yakcc init` Windows behavior is being verified at [#385](https://github.com/cneckar/yakcc/issues/385). The fix may not be complete.

Workaround:

```sh
# Manually trigger each init step
yakcc registry create --path .yakcc/registry.sqlite
echo '{"version":1,"registry":{"path":".yakcc/registry.sqlite"}}' > .yakccrc.json
yakcc hooks claude-code install
```

**PATH not propagating after `export PATH="..."` in PowerShell:**

Use `$env:PATH` syntax in PowerShell:

```powershell
$env:PATH = "$env:USERPROFILE\.yakcc-cli\packages\cli\dist;$env:PATH"
```

Add this to your PowerShell profile (`$PROFILE`) for persistence.

**Line-ending issues with shaved atoms:**

If `yakcc shave` reports CRLF-related errors on Windows, ensure your TypeScript source files are checked out with LF line endings (`git config core.autocrlf false` in the yakcc repo clone and your project repo).

**File a Windows-specific bug:**

If you hit a Windows failure not listed here, file at [github.com/cneckar/yakcc/issues/new](https://github.com/cneckar/yakcc/issues/new) with your Windows version, Node version, shell (PowerShell/WSL/Git Bash), and the exact error message.

---

## 9. `yakcc shave` fails with `DidNotReachAtomError`

**Symptom:** `yakcc shave src/my-file.ts` exits with `DidNotReachAtomError: CallExpression at line N is neither atomic nor decomposable`.

**Cause:** A function body contains a call expression that cannot be reduced to a named atom — typically a higher-order call, an inline callback, or a call to an external module that has not been shaved.

**Fix:**

1. Refactor the offending expression to a named helper function and shave the helper separately.
2. If you are contributing to yakcc itself, add the file to `bootstrap/expected-failures.json` if shaving it is genuinely out of scope.

**Symptom:** `IntentCardSchemaError: behavior must not contain newline characters`

**Fix:** Collapse the `@behavior` JSDoc tag to a single line. Long descriptions belong in the function body doc comment, not in `@behavior`.

---

## Still stuck?

- Check [github.com/cneckar/yakcc/issues](https://github.com/cneckar/yakcc/issues) for known open issues.
- File a new issue with the [alpha-feedback template](https://github.com/cneckar/yakcc/issues/new?template=alpha-feedback.md). Include `yakcc --version`, your platform, the exact commands you ran, and the last 10 lines of `~/.yakcc/telemetry/*.jsonl`.
