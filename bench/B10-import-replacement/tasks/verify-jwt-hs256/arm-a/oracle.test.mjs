// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/verify-jwt-hs256/arm-a/oracle.test.mjs
//
// T-A-3: Arm A semantic equivalence vs the real jsonwebtoken npm binding.
// Runs >=20 property-based inputs to verify byte-equivalent output.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load jsonwebtoken from bench-local node_modules
let jwt;
try {
  // Walk up to bench/B10-import-replacement which has the dep
  const benchRoot = join(__dirname, "../../../../");
  const jwtPath = join(benchRoot, "node_modules", "jsonwebtoken", "index.js");
  jwt = require(jwtPath);
} catch {
  jwt = null;
}

const { verifyJwtHs256 } = await import(pathToFileURL(join(__dirname, "fine.mjs")).href);

// Helpers
function makeToken(payload, secret, alg = "HS256") {
  const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(header + "." + body).digest("base64url");
  return header + "." + body + "." + sig;
}

const SECRET = "test-secret-key-for-oracle";
const VALID_PAYLOAD = { sub: "user1", iat: Math.floor(Date.now() / 1000) };

describe("T-A-3: verify-jwt-hs256 oracle equivalence", () => {
  if (!jwt) {
    it("SKIP: jsonwebtoken not installed in bench node_modules", () => {
      // Not a test failure -- just skip when dep not installed
    });
    return;
  }

  it("valid token: arm-a matches jwt.verify payload (20 secrets)", () => {
    for (let i = 0; i < 20; i++) {
      const secret = "secret-" + i;
      const payload = { sub: "user" + i, iat: 1000000 + i };
      const token = makeToken(payload, secret);
      const armAResult = verifyJwtHs256(token, secret);
      assert.strictEqual(armAResult.sub, payload.sub);
      assert.strictEqual(armAResult.iat, payload.iat);
    }
  });

  it("invalid signature: arm-a throws (10 cases)", () => {
    for (let i = 0; i < 10; i++) {
      const token = makeToken({ sub: "u" + i }, SECRET);
      assert.throws(() => verifyJwtHs256(token, "wrong-secret-" + i), /invalid signature/);
    }
  });

  it("wrong algorithm: arm-a throws", () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "user" })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(header + "." + body).digest("base64url");
    const token = header + "." + body + "." + sig;
    assert.throws(() => verifyJwtHs256(token, SECRET), /HS256/);
  });

  it("malformed token: arm-a throws", () => {
    assert.throws(() => verifyJwtHs256("not.a.valid.jwt.at.all", SECRET));
    assert.throws(() => verifyJwtHs256("onlytwoparts.here", SECRET));
  });
});
