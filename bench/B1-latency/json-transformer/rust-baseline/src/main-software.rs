// SPDX-License-Identifier: MIT
//
// bench/B1-latency/json-transformer/rust-baseline/src/main-software.rs
//
// @decision DEC-BENCH-B1-JSON-RUST-002
// @title Software-only Rust JSON sum-of-leaves — apples-to-apples gate vs yakcc-as WASM
// @status accepted
// @rationale
//   serde_json does not have a "force-soft" feature like sha2 does — there is no SIMD
//   JSON parsing path that can be selectively disabled. Both Rust binaries implement
//   identical serde_json-based DFS traversal. The "software" label is kept for structural
//   consistency with Slice 1's apples-to-apples discipline.
//
//   The verdict gate remains yakcc-as vs rust-software (this binary). The fact that
//   serde_json has no hardware-acceleration feature gate means the two Rust binaries
//   produce identical measurements — this is documented in algorithm.md and the
//   orchestrator's decision annotation.
//
//   DFS traversal: sum_numeric_leaves() walks the serde_json::Value tree recursively,
//   accumulating f64 sum of all Number leaf values. This is the same algorithm as
//   the yakcc-as WASM kernel (which receives a pre-serialized binary flat tree).
//
// Usage: json-transformer-software <corpus-path>

use serde_json::Value;
use std::env;
use std::fs;
use std::time::Instant;

const WARMUP: usize = 100;
const MEASURED: usize = 1000;

/// DFS sum of all numeric leaf values in a JSON tree.
fn sum_numeric_leaves(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::Array(arr) => arr.iter().map(sum_numeric_leaves).sum(),
        Value::Object(map) => map.values().map(sum_numeric_leaves).sum(),
        _ => 0.0,
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: json-transformer-software <corpus-path>");
        std::process::exit(1);
    }
    let corpus_path = &args[1];

    let json_str = fs::read_to_string(corpus_path).unwrap_or_else(|e| {
        eprintln!("Error reading corpus: {}", e);
        std::process::exit(1);
    });

    let size_mb = json_str.len() as f64 / (1024.0 * 1024.0);

    // Parse JSON once outside timing loop — we time only the DFS traversal.
    let tree: Value = serde_json::from_str(&json_str).unwrap_or_else(|e| {
        eprintln!("Error parsing JSON: {}", e);
        std::process::exit(1);
    });

    let total_iters = WARMUP + MEASURED;
    let mut latencies_ns: Vec<u64> = Vec::with_capacity(MEASURED);
    let mut last_sum: f64 = 0.0;

    for i in 0..total_iters {
        let start = Instant::now();
        let sum = sum_numeric_leaves(&tree);
        let elapsed_ns = start.elapsed().as_nanos() as u64;
        last_sum = sum;

        if i >= WARMUP {
            latencies_ns.push(elapsed_ns);
        }
    }

    latencies_ns.sort_unstable();
    let p50_ms = latencies_ns[MEASURED / 2] as f64 / 1_000_000.0;
    let p95_ms = latencies_ns[(MEASURED as f64 * 0.95) as usize] as f64 / 1_000_000.0;
    let p99_ms = latencies_ns[(MEASURED as f64 * 0.99) as usize] as f64 / 1_000_000.0;
    let mean_ns: f64 = latencies_ns.iter().map(|&x| x as f64).sum::<f64>() / MEASURED as f64;
    let mean_ms = mean_ns / 1_000_000.0;
    let throughput_mb_per_sec = size_mb / (mean_ms / 1000.0);

    println!(
        "{{\"comparator\":\"rust-software\",\"p50_ms\":{p50:.6},\"p95_ms\":{p95:.6},\"p99_ms\":{p99:.6},\"mean_ms\":{mean:.6},\"throughput_mb_per_sec\":{tp:.2},\"iterations\":{iters},\"checksum\":{sum:.6}}}",
        p50 = p50_ms,
        p95 = p95_ms,
        p99 = p99_ms,
        mean = mean_ms,
        tp = throughput_mb_per_sec,
        iters = MEASURED,
        sum = last_sum,
    );
}
