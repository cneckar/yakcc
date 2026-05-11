// SPDX-License-Identifier: MIT
//
// bench/B1-latency/integer-math/rust-baseline/src/main-software.rs
//
// @decision DEC-BENCH-B1-RUST-002
// @title Software-only Rust SHA-256 baseline — apples-to-apples gate vs yakcc-as WASM
// @status accepted
// @rationale
//   yakcc-as runs a pure-software SHA-256 in WASM linear memory — it cannot access
//   SHA-NI CPU instructions. Comparing it against hardware-accelerated Rust (main.rs)
//   produces a misleading KILL verdict because the hardware-acceleration gap is
//   irrelevant to the question of whether WASM's JIT overhead is acceptable.
//
//   This binary uses sha2 compiled with the `force-soft` feature, which disables
//   the SHA-NI asm backend and forces the portable pure-Rust implementation.
//   Both yakcc-as and this binary implement the same RFC 6234 SHA-256 algorithm
//   in software — making this the correct apples-to-apples comparator for the
//   15%/40% pass/kill verdict.
//
//   The hardware-accelerated binary (main.rs / rust-baseline-accelerated) is kept
//   as a ceiling reference to show how far WASM is from the CPU's peak throughput.
//
//   Release profile: opt-level=3, lto=fat, codegen-units=1 — maximum optimization
//   that does NOT involve hardware SHA extensions.
//
// Reads the corpus file from argv[1], runs SHA-256 over the 100MB buffer
// 1100 times (100 warm-up + 1000 measured), then prints a JSON result
// to stdout with p50/p95/p99/mean/throughput_mb_per_sec.

use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::time::Instant;

const WARMUP: usize = 100;
const MEASURED: usize = 1000;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: rust-baseline-software <corpus-path>");
        std::process::exit(1);
    }
    let corpus_path = &args[1];

    // Read corpus file
    let buf = fs::read(corpus_path).unwrap_or_else(|e| {
        eprintln!("Error reading corpus: {}", e);
        std::process::exit(1);
    });

    let size_mb = buf.len() as f64 / (1024.0 * 1024.0);
    let total_iters = WARMUP + MEASURED;

    let mut latencies_ns: Vec<u64> = Vec::with_capacity(MEASURED);

    for i in 0..total_iters {
        let start = Instant::now();
        let mut hasher = Sha256::new();
        hasher.update(&buf);
        let _hash = hasher.finalize();
        let elapsed_ns = start.elapsed().as_nanos() as u64;

        if i >= WARMUP {
            latencies_ns.push(elapsed_ns);
        }
    }

    // Compute statistics
    latencies_ns.sort_unstable();
    let p50_ms = latencies_ns[MEASURED / 2] as f64 / 1_000_000.0;
    let p95_ms = latencies_ns[(MEASURED as f64 * 0.95) as usize] as f64 / 1_000_000.0;
    let p99_ms = latencies_ns[(MEASURED as f64 * 0.99) as usize] as f64 / 1_000_000.0;
    let mean_ns: f64 = latencies_ns.iter().map(|&x| x as f64).sum::<f64>() / MEASURED as f64;
    let mean_ms = mean_ns / 1_000_000.0;
    let throughput_mb_per_sec = size_mb / (mean_ms / 1000.0);

    println!(
        "{{\"comparator\":\"rust-software\",\"p50_ms\":{p50:.6},\"p95_ms\":{p95:.6},\"p99_ms\":{p99:.6},\"mean_ms\":{mean:.6},\"throughput_mb_per_sec\":{tp:.2},\"iterations\":{iters}}}",
        p50 = p50_ms,
        p95 = p95_ms,
        p99 = p99_ms,
        mean = mean_ms,
        tp = throughput_mb_per_sec,
        iters = MEASURED,
    );
}
