Implement SemVer range satisfaction checking.

Export a **single class**:

```typescript
export class SemVerRange {
  /**
   * @param range A semver range string.
   * @throws TypeError for unparseable ranges.
   */
  constructor(range: string);

  /**
   * Returns true if `version` satisfies this range.
   * @throws TypeError if `version` is not a valid semver string.
   */
  satisfies(version: string): boolean;
}
```

**Range syntax** (subset of the node-semver spec):

- Simple comparators: `>1.2.3`, `>=1.2.3`, `<1.2.3`, `<=1.2.3`, `=1.2.3` (or `1.2.3`), `*`
- Tilde ranges:
  - `~1.2.3` → `>=1.2.3 <1.3.0`
  - `~1.2`   → `>=1.2.0 <1.3.0`
  - `~1`     → `>=1.0.0 <2.0.0`
- Caret ranges (**critical — `0.x.y` semantics differ from `1.x.y`**):
  - `^1.2.3`   → `>=1.2.3 <2.0.0`   (major is non-zero → locks major)
  - `^0.2.3`   → `>=0.2.3 <0.3.0`   (major is zero, minor non-zero → locks minor)
  - `^0.0.3`   → `>=0.0.3 <0.0.4`   (major+minor zero → locks patch)
  - `^1.2.0`   → `>=1.2.0 <2.0.0`
  - `^0.0.0`   → `>=0.0.0 <0.0.1`
- AND (space-separated): `>=1.0.0 <2.0.0` — both must hold
- OR (`||`-separated): `^1.2.3 || ^2.3.4` — at least one must hold

**Version strings**: standard `MAJOR.MINOR.PATCH` only — no pre-release or build metadata
in the versions passed to `satisfies()`. The range strings also use numeric versions only.

**Comparisons**: strictly numeric (integers). `1.10.0` > `1.9.0`.

Constraints:
- No external libraries.
- `*` matches any valid version.
