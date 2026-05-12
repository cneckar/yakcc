---
name: Alpha feedback
about: Report a bug or rough edge you hit while testing the v0.5.0-alpha
title: "[alpha] "
labels: alpha-feedback
assignees: ''
---

<!--
Thank you for testing the alpha. The more concrete the report, the faster we fix.
See docs/ALPHA.md § "How to send feedback" for the SLA we're working to.
-->

## Version
<!-- Output of `yakcc --version`, OR the git SHA you cloned, OR the alpha tag (e.g. v0.5.0-alpha.0) -->


## Platform
<!-- OS + arch + Node version (e.g. macOS 14.3 arm64, Node 22.5.0) -->


## What you tried
<!-- Exact commands. Copy-paste your shell session if possible. -->

```
$ ...
```

## What you expected


## What happened


## Telemetry sample
<!--
The hook records every emission to ~/.yakcc/telemetry/<session-id>.jsonl.
Include the last ~10 lines so we can see hit/miss/atomize outcomes around the issue.

  tail -10 ~/.yakcc/telemetry/*.jsonl

Telemetry is local-only and never leaves your machine until you paste it here.
Redact any project-name strings you don't want public.
-->

```jsonl

```

## Error output / logs (if any)

```

```

## Severity (your read)
<!-- Pick one — your judgment, we'll adjust if needed -->

- [ ] **Crash / data loss / wrong output** — yakcc destroyed work or produced incorrect code
- [ ] **Walkthrough failure** — followed `docs/USING_YAKCC.md` and hit something that contradicts it
- [ ] **UX rough edge** — works, but worse than it should be
- [ ] **Feature request** — would like X to work; doesn't today

## Anything else
<!-- Workaround you found, related issues you noticed, context that might help -->

---

<!-- DO NOT REMOVE: helps us tag and route -->
<!-- alpha-feedback / v0.5.0 / yakcc-cli -->
