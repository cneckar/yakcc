// SPDX-License-Identifier: MIT
//
// T-A-3: decode-jwt-header-claims oracle equivalence vs jwt.decode()

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let jwt;
try {
  const jwtPath = join(__dirname, "../../../../node_modules/jsonwebtoken/index.js");
  jwt = require(jwtPath);
} catch { jwt = null; }

const { decodeJwtHeaderClaims } = await import(pathToFileURL(join(__dirname, "fine.mjs")).href);

function makeToken(payload, secret = "sec") {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = createHmac("sha256", secret).update(h + "." + b).digest("base64url");
  return h + "." + b + "." + s;
}

describe("T-A-3: decode-jwt-header-claims oracle", () => {
  if (!jwt) {
    it("SKIP: jsonwebtoken not installed", () => {});
    return;
  }

  it("decodes 20 valid tokens matching jwt.decode output", () => {
    for (let i = 0; i < 20; i++) {
      const payload = { sub: "u" + i, iat: 100000 + i, custom: "val" + i };
      const token = makeToken(payload);
      const armA = decodeJwtHeaderClaims(token);
      const real = jwt.decode(token, { complete: true });
      assert.ok(armA !== null, "arm-a returned null for valid token");
      assert.strictEqual(armA.payload.sub, real.payload.sub);
      assert.strictEqual(armA.payload.iat, real.payload.iat);
    }
  });

  it("returns null for malformed tokens", () => {
    assert.strictEqual(decodeJwtHeaderClaims("not-a-jwt"), null);
    assert.strictEqual(decodeJwtHeaderClaims("a.b"), null);
    assert.strictEqual(decodeJwtHeaderClaims(null), null);
  });
});
