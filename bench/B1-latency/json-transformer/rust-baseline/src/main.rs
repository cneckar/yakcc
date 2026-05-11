// SPDX-License-Identifier: MIT
//
// bench/B1-latency/json-transformer/rust-baseline/src/main.rs
//
// @decision DEC-BENCH-B1-JSON-RUST-001
// @title Native Rust JSON sum-of-leaves baseline — standard serde_json (accelerated label)
// @status accepted
// @rationale
//   serde_json does not have feature-gated SIMD acceleration in the same way sha2 does.
//   Both Rust binaries use identical serde_json capabilities. The "accelerated" label is
//   kept for structural consistency with Slice 1's 4-comparator format.
//   The algorithm:
//     1. Parse JSON corpus once with serde_json (outside the timing loop)
//     2. Per iteration: DFS-walk the serde_json::Value tree, accumulating f64 sum
//        of all Number leaf values
//     3. Print JSON stats to stdout
//   This isolates the measurement to DFS traversal throughput, equivalent to the
//   work done by yakcc-as on its pre-parsed binary tree representation.
//
// Usage: json-transformer-accelerated <corpus-path>

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
        eprintln!("Usage: json-transformer-accelerated <corpus-path>");
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

    // Prevent dead-code elimination: print sum as part of output
    // (included in the JSON result so the orchestrator can use it for correctness verification)
    latencies_ns.sort_unstable();
    let p50_ms = latencies_ns[MEASURED / 2] as f64 / 1_000_000.0;
    let p95_ms = latencies_ns[(MEASURED as f64 * 0.95) as usize] as f64 / 1_000_000.0;
    let p99_ms = latencies_ns[(MEASURED as f64 * 0.99) as usize] as f64 / 1_000_000.0;
    let mean_ns: f64 = latencies_ns.iter().map(|&x| x as f64).sum::<f64>() / MEASURED as f64;
    let mean_ms = mean_ns / 1_000_000.0;
    let throughput_mb_per_sec = size_mb / (mean_ms / 1000.0);

    println!(
        "{{\"comparator\":\"rust-accelerated\",\"p50_ms\":{p50:.6},\"p95_ms\":{p95:.6},\"p99_ms\":{p99:.6},\"mean_ms\":{mean:.6},\"throughput_mb_per_sec\":{tp:.2},\"iterations\":{iters},\"checksum\":{sum:.6}}}",
        p50 = p50_ms,
        p95 = p95_ms,
        p99 = p99_ms,
        mean = mean_ms,
        tp = throughput_mb_per_sec,
        iters = MEASURED,
        sum = last_sum,
    );
}
