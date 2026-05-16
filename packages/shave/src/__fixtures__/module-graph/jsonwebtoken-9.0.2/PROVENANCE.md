# Provenance — jsonwebtoken@9.0.2 fixture

- **Package:** jsonwebtoken
- **Version:** 9.0.2 (latest `latest` dist-tag as of 2026-05-16)
- **Source:** npm tarball (`npm pack jsonwebtoken@9.0.2`)
- **Tarball SHA1:** 65ff91f4abef1784697d40952bb1998c504caaf3
- **Tarball integrity:** sha512-PRp66vJ865SSqOlgqS8hujT5U4AOgMfhrwYIuIhfKaoSCZcirrmASQr8CX7cUg+RMih+hgznrjp99o+W4pJLHQ==
- **Retrieved:** 2026-05-16
- **Contents:** 15 files. package.json#main -> "index.js". Top-level: index.js, decode.js,
  sign.js, verify.js. lib/: JsonWebTokenError.js, NotBeforeError.js, TokenExpiredError.js,
  asymmetricKeyDetailsSupported.js, psSupported.js, rsaPssKeyDetailsSupported.js,
  timespan.js, validateAsymmetricKey.js. Plus README.md, LICENSE.
- **Shape:** Plain modern Node.js CommonJS. Every *.js opens with `const x = require('./y')`
  or `var x = require('./y')`. Mix of `module.exports = function ...` and
  `module.exports = { ... }`. NOT Babel-transpiled.
- **Runtime dependencies (10 npm + 1 builtin):**
  - ms (^2.1.1) -- used by lib/timespan.js
  - jws (^3.2.2) -- used by decode.js and verify.js
  - semver (^7.5.4) -- used by lib/psSupported.js, lib/asymmetricKeyDetailsSupported.js, lib/rsaPssKeyDetailsSupported.js
  - lodash.once (^4.0.0), lodash.includes (^4.3.0), lodash.isnumber (^3.0.3),
    lodash.isstring (^4.0.1), lodash.isboolean (^3.0.3), lodash.isinteger (^4.0.4),
    lodash.isplainobject (^4.0.6) -- all used by sign.js
  - crypto (Node builtin) -- used by verify.js and sign.js via destructured import
- **Headline behaviors (this slice):** verify (HS256-verify) -> verify.js; decode-base64url + parse-jose-header -> decode.js
  (per DEC-WI510-S6-JWT-HS256-VERIFY-BINDING-001, DEC-WI510-S6-JWT-DECODE-BASE64URL-BINDING-001, DEC-WI510-S6-JWT-PARSE-JOSE-HEADER-BINDING-001).
- **Path decision:** Path A (published CJS tarball) -- inherits Slice 3 DEC-WI510-S3-FIXTURE-FULL-TARBALL-001
  and Slice 4 DEC-WI510-S4-FIXTURE-FULL-TARBALL-001.
- **Why pin 9.0.2:** Current latest dist-tag, auth0's stable line, plain CJS source shape
  (structurally simpler than Babel-transpiled validator-13.15.35), 10 runtime deps + 1 builtin
  exercise the engine's external-fan-out path (first WI-510 fixture to do so at this breadth).
- **WI:** WI-510 Slice 6, workflow `wi-510-s6-jsonwebtoken-bcrypt`.
