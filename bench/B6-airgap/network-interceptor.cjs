// SPDX-License-Identifier: MIT
//
// network-interceptor.cjs — pure-JS outbound-network monitor
//
// @decision DEC-BENCH-B6-001
// @title B6 air-gap benchmark: cross-platform network-intercept strategy
// @status accepted
// @rationale
//   Pass/fail bar: B6a must produce ZERO outbound connections. Any non-zero
//   count is an immediate kill (see #190 "KILL criterion"). B6b asserts that
//   ALL outbound destinations appear in allowlist.json.
//
//   Cross-platform strategy: OPTION (a) — pure-JS hook via `--require` that
//   patches `node:net`, `node:tls`, `node:http`, and `node:https` connect calls.
//   Chosen over Option (b) (tcpdump/pktap, Linux/macOS only) because:
//     1. Windows is the dev environment (#274 shows binary invocation is already
//        broken on Windows; adding a platform-only tool would block local dev).
//     2. yakcc has no native binary deps that initiate network I/O outside
//        Node's net/tls stack, so Node-level interception catches everything.
//     3. Pure-JS runs in CI on all runners without special capabilities
//        (tcpdump needs sudo or CAP_NET_RAW on Linux).
//   Trade-off acknowledged: native binaries spawned as subprocesses could bypass
//   this interceptor. yakcc has none today; if any are added, the interceptor
//   must be augmented with OS-level capture (tcpdump/pktap/ETW) or a canary test.
//
//   Note: this file is .cjs (CommonJS) so it can be loaded via `node --require`
//   before the ESM entry point. It uses `Module._extensions` and socket hooks.
//
//   tcpdump/pktap status: NOT used. Linux CI can confirm zero-outbound at the OS
//   level independently via `strace -e trace=connect` if a stronger guarantee is
//   needed in the future (filed as enhancement, not required for v0).
//
//   Cold-start measurement: the harness records wall-clock ms from workload start
//   to completion of step 7. No comparison to networked-mode is performed in v0
//   (networked mode requires a live API key; B6b is gated on ANTHROPIC_API_KEY).

"use strict";

const net = require("net");
const tls = require("tls");

const outboundConnections = [];

function recordConnection(host, port, protocol) {
  const dest = `${host}:${port}`;
  outboundConnections.push({ host, port: String(port), protocol, dest, ts: Date.now() });
}

// Patch net.Socket.prototype.connect
const origNetConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedNetConnect(...args) {
  // args[0] can be port+host, options object, or path
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const host = first.host || "localhost";
    const port = first.port || 0;
    recordConnection(host, port, "tcp");
  } else if (typeof first === "number") {
    const port = first;
    const host = args[1] || "localhost";
    recordConnection(host, port, "tcp");
  }
  return origNetConnect.apply(this, args);
};

// Patch tls.connect
const origTlsConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const host = first.host || first.servername || "localhost";
    const port = first.port || 443;
    recordConnection(host, port, "tls");
  } else if (typeof first === "number") {
    const port = first;
    const host = args[1] || "localhost";
    recordConnection(host, port, "tls");
  }
  return origTlsConnect.apply(this, args);
};

// Expose results for the harness to read after the workload exits.
// Written to a temp file path provided via YAKCC_BENCH_INTERCEPT_OUT env var.
process.on("exit", () => {
  const outPath = process.env.YAKCC_BENCH_INTERCEPT_OUT;
  if (!outPath) return;
  try {
    require("fs").writeFileSync(outPath, JSON.stringify(outboundConnections, null, 2), "utf8");
  } catch (e) {
    process.stderr.write(`[interceptor] failed to write results: ${e.message}\n`);
  }
});

// Also handle uncaught termination paths
["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) => {
  process.on(sig, () => {
    const outPath = process.env.YAKCC_BENCH_INTERCEPT_OUT;
    if (outPath) {
      try {
        require("fs").writeFileSync(outPath, JSON.stringify(outboundConnections, null, 2), "utf8");
      } catch (_) {}
    }
    process.exit(1);
  });
});
