// SPDX-License-Identifier: MIT
//
// bench/B1-latency/http-routing/rust-baseline/src/main-software.rs
//
// @decision DEC-BENCH-B1-HTTP-RUST-002
// @title Rust "software" HTTP routing trie — apples-to-apples gate vs yakcc-as WASM
// @status accepted
// @rationale
//   HTTP routing has no hardware-acceleration analog (unlike sha2's SHA-NI or serde_json SIMD).
//   Both Rust bins implement the same hand-rolled u32-keyed trie.
//   The "software" label is the verdict gate: yakcc-as degradation is measured vs this bin.
//   Structurally identical to main.rs — the dual-bin pattern mirrors Slices 1+2.
//
// Usage: http-routing-software <table-path> <query-path>

use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::time::Instant;

const WARMUP: usize = 100;
const MEASURED: usize = 1000;

const PARAM_SENTINEL: u32    = 0x00000001;
const WILDCARD_SENTINEL: u32 = 0x00000002;
const NO_HANDLER: u32        = 0xFFFFFFFF;

fn hash_segment(s: &str) -> u32 {
    let mut h: u32 = 5381;
    for b in s.bytes() {
        h = h.wrapping_shl(5).wrapping_add(h) ^ (b as u32);
    }
    if h < 3 { h += 3; }
    h
}

#[derive(Default)]
struct TrieNode {
    children: HashMap<u32, usize>,
    handler_id: u32,
}

impl TrieNode {
    fn new() -> Self {
        TrieNode { children: HashMap::new(), handler_id: NO_HANDLER }
    }
}

#[derive(Deserialize)]
struct Rule {
    pattern: String,
    handler_id: u32,
    #[allow(dead_code)]
    r#type: String,
}

fn build_trie(rules: &[Rule]) -> Vec<TrieNode> {
    let mut nodes = vec![TrieNode::new()];
    for rule in rules {
        let raw_segs: Vec<&str> = rule.pattern.split('/').filter(|s| !s.is_empty()).collect();
        let mut node_idx = 0usize;
        for seg in &raw_segs {
            let key = if seg.starts_with(':') {
                PARAM_SENTINEL
            } else if seg.starts_with('*') {
                WILDCARD_SENTINEL
            } else {
                hash_segment(seg)
            };
            if let Some(&child_idx) = nodes[node_idx].children.get(&key) {
                node_idx = child_idx;
            } else {
                let child_idx = nodes.len();
                nodes.push(TrieNode::new());
                nodes[node_idx].children.insert(key, child_idx);
                node_idx = child_idx;
            }
        }
        nodes[node_idx].handler_id = rule.handler_id;
    }
    nodes
}

fn prehash_queries(queries: &[String]) -> Vec<Vec<u32>> {
    queries.iter().map(|path| {
        path.split('/').filter(|s| !s.is_empty()).map(hash_segment).collect()
    }).collect()
}

#[inline(always)]
fn match_path(nodes: &[TrieNode], segs: &[u32]) -> (bool, u32) {
    let mut node_idx = 0usize;
    let mut captures: u32 = 0;
    for &seg_hash in segs {
        let node = &nodes[node_idx];
        if let Some(&exact) = node.children.get(&seg_hash) {
            node_idx = exact;
            continue;
        }
        if let Some(&param) = node.children.get(&PARAM_SENTINEL) {
            captures += 1;
            node_idx = param;
            continue;
        }
        if let Some(&wild) = node.children.get(&WILDCARD_SENTINEL) {
            captures += 1;
            let matched = nodes[wild].handler_id != NO_HANDLER;
            return (matched, captures);
        }
        return (false, captures);
    }
    let matched = nodes[node_idx].handler_id != NO_HANDLER;
    (matched, captures)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: http-routing-software <table-path> <query-path>");
        std::process::exit(1);
    }

    let table_json = fs::read_to_string(&args[1]).unwrap_or_else(|e| {
        eprintln!("Error reading table: {}", e); std::process::exit(1);
    });
    let query_json = fs::read_to_string(&args[2]).unwrap_or_else(|e| {
        eprintln!("Error reading queries: {}", e); std::process::exit(1);
    });

    let rules: Vec<Rule> = serde_json::from_str(&table_json).unwrap_or_else(|e| {
        eprintln!("Error parsing table: {}", e); std::process::exit(1);
    });
    let queries: Vec<String> = serde_json::from_str(&query_json).unwrap_or_else(|e| {
        eprintln!("Error parsing queries: {}", e); std::process::exit(1);
    });

    let nodes          = build_trie(&rules);
    let hashed_queries = prehash_queries(&queries);

    let total_iters = WARMUP + MEASURED;
    let mut latencies_ns: Vec<u64> = Vec::with_capacity(MEASURED);
    let mut last_matched: u64  = 0;
    let mut last_captures: u64 = 0;

    for i in 0..total_iters {
        let mut matched_count: u64  = 0;
        let mut total_captures: u64 = 0;

        let start = Instant::now();
        for segs in &hashed_queries {
            let (matched, caps) = match_path(&nodes, segs);
            if matched { matched_count += 1; }
            total_captures += caps as u64;
        }
        let elapsed_ns = start.elapsed().as_nanos() as u64;

        last_matched  = matched_count;
        last_captures = total_captures;

        if i >= WARMUP {
            latencies_ns.push(elapsed_ns);
        }
    }

    latencies_ns.sort_unstable();
    let p50_ms  = latencies_ns[MEASURED / 2] as f64 / 1_000_000.0;
    let p95_ms  = latencies_ns[(MEASURED as f64 * 0.95) as usize] as f64 / 1_000_000.0;
    let p99_ms  = latencies_ns[(MEASURED as f64 * 0.99) as usize] as f64 / 1_000_000.0;
    let mean_ns: f64 = latencies_ns.iter().map(|&x| x as f64).sum::<f64>() / MEASURED as f64;
    let mean_ms = mean_ns / 1_000_000.0;
    let qps = queries.len() as f64 / (mean_ms / 1000.0);

    println!(
        "{{\"comparator\":\"rust-software\",\"p50_ms\":{p50:.6},\"p95_ms\":{p95:.6},\"p99_ms\":{p99:.6},\"mean_ms\":{mean:.6},\"queries_per_sec\":{qps:.0},\"iterations\":{iters},\"matched_count\":{mc},\"total_captures\":{tc}}}",
        p50  = p50_ms,
        p95  = p95_ms,
        p99  = p99_ms,
        mean = mean_ms,
        qps  = qps,
        iters = MEASURED,
        mc   = last_matched,
        tc   = last_captures,
    );
}
