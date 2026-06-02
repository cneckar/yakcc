// rust-ast-parse -- syn-based AST parser subprocess for @yakcc/shave-rust (WI-868 slice 1).
//
// Reads Rust source from stdin, parses with syn, and writes a JSON envelope
// to stdout.  Exit code 0 on success; non-zero on error (error message on stderr).
//
// @decision DEC-POLYGLOT-RUST-SYN-PARSER-001 (WI-868 slice 1)
// @title syn is the canonical Rust AST library for the subprocess parser
// @status accepted (WI-868 slice 1)
// @rationale
//   syn is the de-facto standard Rust parser used by the entire macro ecosystem
//   (serde_derive, thiserror, async-trait, etc.).  It produces a complete,
//   typed AST for any valid Rust source without requiring the full rustc frontend.
//   Alternatives considered: tree-sitter-rust (not native Rust, Node binding
//   needed), rustc's own parser (private API, unstable), pest grammars (too low
//   level).  syn with serde_json is ~120KB compiled and adds no runtime deps
//   beyond the stdlib — ideal for a per-file subprocess invocation model.
//
// Wire shape (version=1):
//   {
//     "version": 1,
//     "crateName": "stdin.rs",
//     "functions": [
//       {
//         "name": "add_numbers",
//         "isPub": true,
//         "params": [{"name": "a", "rustType": "i32"}, {"name": "b", "rustType": "i32"}],
//         "returnType": "i32",
//         "bodySource": "a + b"
//       }
//     ]
//   }
//
// Slice 1: signature surface only (name, isPub, params, returnType, bodySource).
// Slice 2 will add structured body AST nodes.
//
// Usage (via cargo run):
//   cargo run --quiet --manifest-path <path>/Cargo.toml < input.rs
//
// Usage (pre-built binary):
//   ./rust-ast-parse < input.rs

use std::io::{self, Read};

use serde::Serialize;
use syn::{FnArg, Item, Pat, ReturnType, Type, Visibility};

// ---------------------------------------------------------------------------
// Wire types (serialised to JSON stdout)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Param {
    name: String,
    #[serde(rename = "rustType")]
    rust_type: String,
}

#[derive(Serialize)]
struct FunctionEntry {
    name: String,
    #[serde(rename = "isPub")]
    is_pub: bool,
    params: Vec<Param>,
    #[serde(rename = "returnType")]
    return_type: String,
    #[serde(rename = "bodySource")]
    body_source: Option<String>,
}

#[derive(Serialize)]
struct Envelope {
    version: u32,
    #[serde(rename = "crateName")]
    crate_name: String,
    functions: Vec<FunctionEntry>,
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let mut src = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut src) {
        eprintln!("rust-ast-parse: read stdin: {e}");
        std::process::exit(1);
    }

    let file = match syn::parse_file(&src) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("rust-ast-parse: parse error: {e}");
            std::process::exit(1);
        }
    };

    let mut functions = Vec::new();

    for item in &file.items {
        if let Item::Fn(item_fn) = item {
            let name = item_fn.sig.ident.to_string();
            let is_pub = matches!(item_fn.vis, Visibility::Public(_));

            // Collect parameters (skip `self` receivers).
            let params: Vec<Param> = item_fn
                .sig
                .inputs
                .iter()
                .filter_map(|arg| match arg {
                    FnArg::Typed(pat_type) => {
                        let param_name = extract_pat_name(&pat_type.pat);
                        let rust_type = type_to_string(&pat_type.ty);
                        Some(Param {
                            name: param_name,
                            rust_type,
                        })
                    }
                    FnArg::Receiver(_) => None,
                })
                .collect();

            // Return type: empty string for unit return `()`.
            let return_type = match &item_fn.sig.output {
                ReturnType::Default => String::new(),
                ReturnType::Type(_, ty) => {
                    let s = type_to_string(ty);
                    // Explicit `-> ()` is the same as no return.
                    if s == "()" { String::new() } else { s }
                }
            };

            // Body source: the block tokens as a string (for diagnostics/slice 2).
            let body_source = Some(block_to_source(&item_fn.block));

            functions.push(FunctionEntry {
                name,
                is_pub,
                params,
                return_type,
                body_source,
            });
        }
    }

    let envelope = Envelope {
        version: 1,
        crate_name: "stdin.rs".to_string(),
        functions,
    };

    match serde_json::to_string(&envelope) {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("rust-ast-parse: JSON serialization error: {e}");
            std::process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract a simple identifier name from a pattern.
/// For `Pat::Ident` returns the identifier string.
/// For complex patterns (e.g. tuple destructuring) returns a synthesized name.
fn extract_pat_name(pat: &Pat) -> String {
    match pat {
        Pat::Ident(p) => p.ident.to_string(),
        Pat::Wild(_) => "_".to_string(),
        Pat::Reference(r) => extract_pat_name(&r.pat),
        Pat::Tuple(_) => "_tuple".to_string(),
        Pat::TupleStruct(_) => "_struct".to_string(),
        _ => "_".to_string(),
    }
}

/// Convert a syn Type to a source string.
///
/// Uses quote::ToTokens to produce a token stream, then normalises spacing
/// to match idiomatic Rust type notation.
fn type_to_string(ty: &Type) -> String {
    use syn::__private::ToTokens;
    let tokens = ty.to_token_stream().to_string();
    normalise_type_string(&tokens)
}

/// Normalise whitespace in a syn-generated type string to match the canonical
/// Rust source form that callers expect.
///
/// syn's token stream adds spaces in places humans don't:
///   "& str"        -> "&str"
///   "& 'a str"     -> "&'a str"
///   "Vec < i32 >"  -> "Vec<i32>"
///   "i32"          -> "i32"  (no change)
fn normalise_type_string(s: &str) -> String {
    let s = s.trim();
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let mut i = 0;

    while i < n {
        let c = chars[i];
        if c == ' ' {
            let prev = if i > 0 { chars[i - 1] } else { '\0' };
            let next = if i + 1 < n { chars[i + 1] } else { '\0' };
            // Suppress spaces that produce non-idiomatic output.
            let suppress = prev == '&'
                || prev == '<'
                || next == '<'
                || next == '>'
                || next == ','
                || (prev == '\'' && (next.is_alphanumeric() || next == '_'));
            if !suppress {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// Extract the body of a function block as a source string.
///
/// Uses syn's ToTokens to produce the block token stream, then strips the
/// outer braces to return just the body text.
fn block_to_source(block: &syn::Block) -> String {
    use syn::__private::ToTokens;
    let tokens = block.to_token_stream().to_string();
    // The token stream includes the outer `{ ... }` — strip them.
    let inner = tokens
        .trim_start_matches('{')
        .trim_end_matches('}')
        .trim();
    inner.to_string()
}
