# Release Guide

This document covers the release process for yakcc packages, OIDC trusted-publisher setup, and the per-new-package pre-configuration requirement that surfaced via issues #856 / #857 / #858.

## 1. Release overview

Two packages publish on every release:

| Package | Install path |
|---|---|
| `@yakcc/cli` | `npm install @yakcc/cli` (scoped, primary) |
| `yakcc` | `npm install yakcc` (unscoped wrapper, convenience alias) |

Both packages are built from the same source. The unscoped `yakcc` package is a thin wrapper so users can install by the short name.

Releases use **OIDC trusted publishing** -- no NPM tokens are stored as GitHub secrets. A manual approval gate is enforced via the `release` GitHub Environment (reviewer: cneckar).

Decision references:
- `DEC-WI834-001` -- single-package architecture (cli bundles)
- `DEC-WI834-004` -- release workflow split (version PR + publish-on-tag)
- `DEC-WI845-OIDC` -- OIDC trusted publishing migration
- `DEC-WI856-WRAPPER` -- unscoped `yakcc` wrapper

## 2. Operator flow (each release)

After feature merges accumulate on main and you are ready to cut a release:

```bash
# Bump the alpha number (or promote to stable when the time comes)
git tag -f release-v0.6.0-alpha.N

# Push the tag to trigger the release workflow
git push -f origin release-v0.6.0-alpha.N
```

Then:

1. Navigate to [GitHub Actions](https://github.com/cneckar/yakcc/actions) and find the release workflow run.
2. Approve the deployment in the GH UI (required by the `release` Environment gate).
3. The workflow publishes both packages with `--tag latest` and a sigstore provenance attestation.

Both packages must publish in the same run. If one fails, see Section 4.

## 3. One-time per-new-publishable-package: configure trusted publisher

**This is the gap that surfaced via #856 / #857 / #858.**

Before merging a PR that adds a new publishable package (any `package.json` with `"private": false` and a new `name`), the trusted publisher entry for that package name must already exist on npm. npm allows pre-configuring a trusted publisher for a package that does not yet exist -- the configuration is tied to the package name, not to whether the package has been published before.

**If you skip this step, the first publish will 404 (see Section 4).**

### Steps

1. Go to [https://www.npmjs.com/settings/yakcc/packages](https://www.npmjs.com/settings/yakcc/packages)
2. Navigate to **Trusted publishers** -> **Add new**
3. Fill in the form:

| Field | Value |
|---|---|
| Package name | The exact new package name, e.g. `yakcc`, `@yakcc/cli`, `@yakcc/contracts` |
| Repository | `cneckar/yakcc` |
| Workflow filename | `release.yml` |
| Environment | `release` |

4. Save. The entry takes effect immediately.

Repeat this for every new `name` that will be published. The two existing entries (`@yakcc/cli` and `yakcc`) were configured this way before their respective first publishes.

## 4. Recovering from "first publish 404d"

Symptom: the release workflow run appears to succeed for `@yakcc/cli` but fails on the new package with:

```
Not Found - PUT https://registry.npmjs.org/<name>
```

This means the trusted publisher entry was missing when the publish ran. To recover:

1. Add the trusted publisher entry per Section 3.
2. Re-tag and re-push to trigger a new workflow run:
   ```bash
   git tag -f release-v<version>
   git push -f origin release-v<version>
   ```
3. Approve in the GH UI again.
4. The workflow re-runs. The already-published package (`@yakcc/cli` or whichever succeeded) will be a no-op because that version already exists on npm. The new package publishes for the first time.

No manual `npm publish` is needed; let the workflow handle it.

## 5. Promoting versions between dist-tags (manual override)

By default, the release workflow publishes both packages with `tag: latest` as specified in each package's `publishConfig.tag`. If you want a release to land on `next` or `alpha` instead:

```bash
# After the workflow completes, override the dist-tag routing:
npm dist-tag add @yakcc/cli@<version> next
npm dist-tag add yakcc@<version> next
```

Alternatively, change `publishConfig.tag` in the relevant `package.json` before tagging so the workflow publishes directly to the target tag.

## 6. Provenance attestation

Every publish includes a sigstore provenance statement bound to:

- The exact GitHub Actions workflow run that published it
- The git commit SHA at the time of publish
- The `cneckar/yakcc` repository identity

Consumers can verify package provenance:

```bash
npm view @yakcc/cli provenance
# or
npm audit signatures
```

This means any package published through the release workflow is cryptographically traceable to its source commit and build environment.
