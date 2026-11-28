# V8 12.4.254.21 sources (vendored, in part)

Files of V8 12.4.254.21, the V8 in Node v22.23.5 (`deps/v8` of Node's release tarball,
https://nodejs.org/dist/v22.23.5/node-v22.23.5.tar.gz, SHA-256
`5ae198a2ec0513ea8b7ef28f71094c9a7931a44e4db17b1734d76fe958e0ff36`), unmodified, under V8's
license (`LICENSE`), for the C++ front end to shave:

- `src/base/ieee754.cc` and the `src/base` headers it includes, with `include/v8config.h`:
  `Math`'s transcendental functions (#1362, `src/atoms/math.ts`).
- `src/bigint/` (all of it): BigInt's digit arithmetic (add, subtract, multiply up to FFT,
  divide up to Barrett, bitwise, shifts, `AsIntN`/`AsUintN`, `ToString`, `FromString`), shaved
  as one unit, `src/atoms/v8/bigint.cc` (#1516).

Everything here touches no V8 object; V8's built-ins over its object model wait on #1366.
