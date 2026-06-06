// rust-ast-parse -- syn-based AST parser subprocess for @yakcc/shave-rust (WI-868 slice 1+2).
//
// Reads Rust source from stdin, parses with syn, and writes a JSON envelope
// to stdout.  Exit code 0 on success; non-zero on error (message on stderr).
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
//   beyond the stdlib -- ideal for a per-file subprocess invocation model.
//
// @decision DEC-POLYGLOT-RUST-BODY-AST-V2-001 (WI-868-2A, 2026-06-02)
// @title Version-2 envelope with structured body AST (discriminated-union nodes)
// @status accepted
// @rationale
//   Slice 2 bumps the envelope to version=2 and adds a `body` field carrying a
//   structured RustBodyNode (discriminated-union AST) alongside the retained
//   `bodySource` string (diagnostics only).  Mirrors DEC's go-ast-parse v1->v2
//   pattern.  syn's full-feature parse gives every Expr/Stmt variant; unsupported
//   variants (match, loop, closure, ?, unsafe, async, struct-lit, macro) emit
//   UnsupportedExpr/UnsupportedStmt so raise-body.ts can throw typed errors
//   without re-parsing bodySource (DEC-POLYGLOT-RUST-MVP-BODY-COVERAGE-001).
//   Single-version: v1 is permanently retired after this commit -- no fallback.
//
// Wire shape (version=2):
//   {
//     "version": 2,
//     "crateName": "stdin.rs",
//     "functions": [
//       {
//         "name": "add",
//         "isPub": true,
//         "params": [{"name": "a", "rustType": "i32"}, {"name": "b", "rustType": "i32"}],
//         "returnType": "i32",
//         "bodySource": "a + b",
//         "body": {
//           "stmts": [
//             { "type": "ExprStmt", "isTail": true,
//               "x": { "type": "BinaryExpr", "op": "+",
//                 "x": {"type":"Ident","name":"a","line":1,"col":25},
//                 "y": {"type":"Ident","name":"b","line":1,"col":29},
//                 "line":1,"col":25 },
//               "line":1,"col":25 }
//           ]
//         }
//       }
//     ]
//   }
//
// Slice 2 body node MVP set (DEC-POLYGLOT-RUST-MVP-BODY-COVERAGE-001):
//   Supported:  Ident, Lit (INT/FLOAT/STR/BOOL), BinaryExpr, UnaryExpr (-/!),
//               CallExpr, MethodCallExpr, FieldExpr, IndexExpr, Paren (unwrapped),
//               IfExpr (with else-if + plain-else), ReturnExpr, ReturnStmt,
//               ExprStmt (tail and non-tail), LetStmt.
//   Deferred -> UnsupportedExpr/UnsupportedStmt: loop/while/for, match,
//               closures, ? operator, unsafe/async/.await, struct literals,
//               macro invocations, complex patterns (tuple/struct destructuring).
//
// Usage (via cargo run):
//   cargo run --quiet --manifest-path <path>/Cargo.toml < input.rs
//
// Usage (pre-built binary):
//   ./rust-ast-parse < input.rs

use std::io::{self, Read};

use serde::Serialize;
use syn::{
    BinOp, Expr, FnArg, Item, Pat, ReturnType, Stmt, Type, UnOp, Visibility,
};
use syn::spanned::Spanned;

// ---------------------------------------------------------------------------
// Wire types (serialised to JSON stdout)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Param {
    name: String,
    #[serde(rename = "rustType")]
    rust_type: String,
}

// ---------------------------------------------------------------------------
// Body AST wire types (version 2)
// ---------------------------------------------------------------------------

/// Discriminated-union expression node.
/// `type` is the serde tag discriminant; shape mirrors the v2 wire schema.
///
/// Columns are 1-based (syn columns are 0-based; we add 1), matching
/// go-ast-parse's convention for SourceLocation diagnostics.
#[derive(Serialize)]
#[serde(tag = "type")]
enum RustExprNode {
    /// Bare identifier: a single-segment path with no qualifier.
    Ident {
        name: String,
        line: usize,
        col: usize,
    },
    /// Integer, float, string, or bool literal.
    Lit {
        kind: String,
        value: String,
        line: usize,
        col: usize,
    },
    /// Binary expression: x op y.
    BinaryExpr {
        op: String,
        x: Box<RustExprNode>,
        y: Box<RustExprNode>,
        line: usize,
        col: usize,
    },
    /// Unary expression: -x or !x only.
    /// UnOp::Deref is NOT mapped here (DEC-POLYGLOT-RUST-MVP-BODY-COVERAGE-001).
    UnaryExpr {
        op: String,
        x: Box<RustExprNode>,
        line: usize,
        col: usize,
    },
    /// Function call: fun(args...).
    CallExpr {
        fun: Box<RustExprNode>,
        args: Vec<RustExprNode>,
        line: usize,
        col: usize,
    },
    /// Method call: receiver.method(args...).
    MethodCallExpr {
        receiver: Box<RustExprNode>,
        method: String,
        args: Vec<RustExprNode>,
        line: usize,
        col: usize,
    },
    /// Field access: x.field (named fields only; tuple-index -> UnsupportedExpr).
    FieldExpr {
        x: Box<RustExprNode>,
        field: String,
        line: usize,
        col: usize,
    },
    /// Index expression: x[index].
    IndexExpr {
        x: Box<RustExprNode>,
        index: Box<RustExprNode>,
        line: usize,
        col: usize,
    },
    /// If expression / if-else-if chain.
    IfExpr {
        cond: Box<RustExprNode>,
        #[serde(rename = "thenBranch")]
        then_branch: RustBodyNode,
        /// null=no else; nested IfExpr=else-if chain; BlockNode=plain else
        orelse: Option<Box<RustIfOrelse>>,
        line: usize,
        col: usize,
    },
    /// Explicit `return expr` expression.
    ReturnExpr {
        value: Option<Box<RustExprNode>>,
        line: usize,
        col: usize,
    },
    /// Deferred/unsupported expression -- raise-body.ts throws a typed error.
    UnsupportedExpr {
        reason: String,
        line: usize,
        col: usize,
    },
}

/// The `orelse` arm of an IfExpr: either another IfExpr (else-if chain) or
/// a plain else block represented as a BlockNode.
#[derive(Serialize)]
#[serde(tag = "type")]
enum RustIfOrelse {
    IfExpr {
        cond: Box<RustExprNode>,
        #[serde(rename = "thenBranch")]
        then_branch: RustBodyNode,
        orelse: Option<Box<RustIfOrelse>>,
        line: usize,
        col: usize,
    },
    BlockNode {
        body: RustBodyNode,
    },
}

/// Discriminated-union statement node.
#[derive(Serialize)]
#[serde(tag = "type")]
enum RustStmtNode {
    /// let name = value;  (simple Pat::Ident only; complex pats -> UnsupportedStmt)
    LetStmt {
        name: String,
        value: Option<Box<RustExprNode>>,
        line: usize,
        col: usize,
    },
    /// Expression used as a statement.
    /// isTail=true for the trailing block expression (no semicolon -> implicit return).
    ExprStmt {
        x: Box<RustExprNode>,
        #[serde(rename = "isTail")]
        is_tail: bool,
        line: usize,
        col: usize,
    },
    /// Explicit `return expr;` statement (emitted separately for clean rendering).
    ReturnStmt {
        value: Option<Box<RustExprNode>>,
        line: usize,
        col: usize,
    },
    /// Deferred/unsupported statement -- raise-body.ts throws a typed error.
    UnsupportedStmt {
        reason: String,
        line: usize,
        col: usize,
    },
}

/// Top-level body node: the list of statements for a function block.
#[derive(Serialize)]
struct RustBodyNode {
    stmts: Vec<RustStmtNode>,
}

#[derive(Serialize)]
struct FunctionEntry {
    name: String,
    #[serde(rename = "isPub")]
    is_pub: bool,
    params: Vec<Param>,
    #[serde(rename = "returnType")]
    return_type: String,
    /// Verbatim body source (retained for diagnostics; raise-body.ts uses `body`).
    #[serde(rename = "bodySource")]
    body_source: Option<String>,
    /// Structured body AST (version 2). Null for functions with no block body.
    body: Option<RustBodyNode>,
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

            // Body source: retained for diagnostics (raise-body.ts uses `body`).
            let body_source = Some(block_to_source(&item_fn.block));

            // Structured body AST (version 2).
            let body = Some(marshal_block(&item_fn.block));

            functions.push(FunctionEntry {
                name,
                is_pub,
                params,
                return_type,
                body_source,
                body,
            });
        }
    }

    let envelope = Envelope {
        version: 2,
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
// Body AST marshalling (WI-868-2A)
// ---------------------------------------------------------------------------

/// Marshal a syn::Block into our RustBodyNode wire type.
///
/// Processes all statements in order; the last statement is checked for the
/// tail-expression case (Stmt::Expr without a trailing semicolon -> isTail:true).
fn marshal_block(block: &syn::Block) -> RustBodyNode {
    let mut stmts = Vec::new();
    let len = block.stmts.len();
    for (idx, stmt) in block.stmts.iter().enumerate() {
        let is_last = idx + 1 == len;
        stmts.push(marshal_stmt(stmt, is_last));
    }
    RustBodyNode { stmts }
}

/// Marshal a single syn::Stmt into our RustStmtNode wire type.
///
/// `is_last` is true for the final statement in a block -- used to distinguish
/// the tail-expression case (Stmt::Expr without semi -> isTail:true).
fn marshal_stmt(stmt: &Stmt, is_last: bool) -> RustStmtNode {
    match stmt {
        // Stmt::Local is a `let` binding.
        Stmt::Local(local) => {
            let sp = local.span().start();
            let name = match &local.pat {
                Pat::Ident(p) => p.ident.to_string(),
                Pat::Wild(_) => "_".to_string(),
                other => {
                    // Complex pattern (tuple/struct destructuring) -> deferred.
                    let reason = format!("complex let pattern: {}", pat_kind(other));
                    return RustStmtNode::UnsupportedStmt {
                        reason,
                        line: sp.line,
                        col: sp.column + 1,
                    };
                }
            };
            let value = local.init.as_ref().map(|init| Box::new(marshal_expr(&init.expr)));
            RustStmtNode::LetStmt {
                name,
                value,
                line: sp.line,
                col: sp.column + 1,
            }
        }

        // Stmt::Item (nested item declarations) -> deferred.
        Stmt::Item(_) => {
            let sp = stmt_span_start(stmt);
            RustStmtNode::UnsupportedStmt {
                reason: "Stmt::Item".to_string(),
                line: sp.0,
                col: sp.1,
            }
        }

        // Stmt::Expr covers both expression statements (with semicolon) and the
        // tail expression (without semicolon, the block's implied return value).
        Stmt::Expr(expr, semi) => {
            let sp = expr.span().start();
            let line = sp.line;
            let col = sp.column + 1;

            // Unwrap `return expr` into ReturnStmt for cleaner rendering.
            if let Expr::Return(ret_expr) = expr {
                let value = ret_expr.expr.as_ref().map(|e| Box::new(marshal_expr(e)));
                return RustStmtNode::ReturnStmt { value, line, col };
            }

            let has_semi = semi.is_some();
            // is_tail: last statement AND no semicolon -> implicit return value.
            let is_tail = is_last && !has_semi;
            let x = Box::new(marshal_expr(expr));
            RustStmtNode::ExprStmt { x, is_tail, line, col }
        }

        // Catch-all for future syn variants.
        #[allow(unreachable_patterns)]
        _ => {
            let sp = stmt_span_start(stmt);
            RustStmtNode::UnsupportedStmt {
                reason: "Stmt::Macro".to_string(),
                line: sp.0,
                col: sp.1,
            }
        }
    }
}

/// Marshal a syn::Expr into our RustExprNode wire type.
///
/// Covers the MVP set defined in DEC-POLYGLOT-RUST-MVP-BODY-COVERAGE-001.
/// Every other variant emits UnsupportedExpr with the syn node kind name.
fn marshal_expr(expr: &Expr) -> RustExprNode {
    match expr {
        // --- Identifier (single-segment path only) ---
        Expr::Path(ep) => {
            let sp = ep.span().start();
            let line = sp.line;
            let col = sp.column + 1;
            if ep.qself.is_none() && ep.path.segments.len() == 1 {
                let name = ep.path.segments[0].ident.to_string();
                RustExprNode::Ident { name, line, col }
            } else {
                // Multi-segment path (e.g. std::i32::MAX) -> deferred.
                RustExprNode::UnsupportedExpr {
                    reason: "Expr::Path (multi-segment)".to_string(),
                    line,
                    col,
                }
            }
        }

        // --- Literals ---
        Expr::Lit(el) => {
            let sp = el.span().start();
            let line = sp.line;
            let col = sp.column + 1;
            match &el.lit {
                syn::Lit::Int(v) => RustExprNode::Lit {
                    kind: "INT".to_string(),
                    value: v.base10_digits().to_string(),
                    line,
                    col,
                },
                syn::Lit::Float(v) => RustExprNode::Lit {
                    kind: "FLOAT".to_string(),
                    value: v.base10_digits().to_string(),
                    line,
                    col,
                },
                syn::Lit::Str(v) => RustExprNode::Lit {
                    kind: "STR".to_string(),
                    // syn::LitStr::value() gives the decoded (unescaped) string --
                    // better than go which needed eval(); syn gives it directly.
                    value: v.value(),
                    line,
                    col,
                },
                syn::Lit::Bool(v) => RustExprNode::Lit {
                    kind: "BOOL".to_string(),
                    value: if v.value { "true" } else { "false" }.to_string(),
                    line,
                    col,
                },
                // Byte, ByteStr, Char, other -> deferred.
                _ => RustExprNode::UnsupportedExpr {
                    reason: "Expr::Lit (non-int/float/str/bool)".to_string(),
                    line,
                    col,
                },
            }
        }

        // --- Binary expression ---
        Expr::Binary(eb) => {
            let sp = eb.span().start();
            RustExprNode::BinaryExpr {
                op: binop_to_str(&eb.op).to_string(),
                x: Box::new(marshal_expr(&eb.left)),
                y: Box::new(marshal_expr(&eb.right)),
                line: sp.line,
                col: sp.column + 1,
            }
        }

        // --- Unary expression (-x or !x only; Deref -> deferred) ---
        Expr::Unary(eu) => {
            let sp = eu.span().start();
            let line = sp.line;
            let col = sp.column + 1;
            let op_str = match &eu.op {
                UnOp::Neg(_) => Some("-"),
                UnOp::Not(_) => Some("!"),
                _ => None,
            };
            match op_str {
                Some(op) => RustExprNode::UnaryExpr {
                    op: op.to_string(),
                    x: Box::new(marshal_expr(&eu.expr)),
                    line,
                    col,
                },
                None => RustExprNode::UnsupportedExpr {
                    reason: "Expr::Unary (Deref or unsupported op)".to_string(),
                    line,
                    col,
                },
            }
        }

        // --- Function call ---
        Expr::Call(ec) => {
            let sp = ec.span().start();
            let args = ec.args.iter().map(marshal_expr).collect();
            RustExprNode::CallExpr {
                fun: Box::new(marshal_expr(&ec.func)),
                args,
                line: sp.line,
                col: sp.column + 1,
            }
        }

        // --- Method call ---
        Expr::MethodCall(em) => {
            let sp = em.span().start();
            let method = em.method.to_string();
            let args = em.args.iter().map(marshal_expr).collect();
            RustExprNode::MethodCallExpr {
                receiver: Box::new(marshal_expr(&em.receiver)),
                method,
                args,
                line: sp.line,
                col: sp.column + 1,
            }
        }

        // --- Field access (named fields only) ---
        Expr::Field(ef) => {
            let sp = ef.span().start();
            let line = sp.line;
            let col = sp.column + 1;
            match &ef.member {
                syn::Member::Named(ident) => RustExprNode::FieldExpr {
                    x: Box::new(marshal_expr(&ef.base)),
                    field: ident.to_string(),
                    line,
                    col,
                },
                syn::Member::Unnamed(_) => RustExprNode::UnsupportedExpr {
                    reason: "Expr::Field (tuple-index)".to_string(),
                    line,
                    col,
                },
            }
        }

        // --- Index expression ---
        Expr::Index(ei) => {
            let sp = ei.span().start();
            RustExprNode::IndexExpr {
                x: Box::new(marshal_expr(&ei.expr)),
                index: Box::new(marshal_expr(&ei.index)),
                line: sp.line,
                col: sp.column + 1,
            }
        }

        // --- Parenthesized expression (unwrap transparently) ---
        Expr::Paren(ep) => marshal_expr(&ep.expr),

        // --- If expression ---
        Expr::If(ei) => {
            let sp = ei.span().start();
            let then_branch = marshal_block(&ei.then_branch);
            let orelse = ei.else_branch.as_ref().map(|(_, else_expr)| {
                Box::new(marshal_if_orelse(else_expr))
            });
            RustExprNode::IfExpr {
                cond: Box::new(marshal_expr(&ei.cond)),
                then_branch,
                orelse,
                line: sp.line,
                col: sp.column + 1,
            }
        }

        // --- Explicit return expression ---
        Expr::Return(er) => {
            let sp = er.span().start();
            let value = er.expr.as_ref().map(|e| Box::new(marshal_expr(e)));
            RustExprNode::ReturnExpr {
                value,
                line: sp.line,
                col: sp.column + 1,
            }
        }

        // --- Deferred constructs -- emit UnsupportedExpr with syn kind string ---
        Expr::Block(_) => unsupported_expr(expr, "Expr::Block"),
        Expr::Match(_) => unsupported_expr(expr, "Expr::Match"),
        Expr::Loop(_) => unsupported_expr(expr, "Expr::Loop"),
        Expr::While(_) => unsupported_expr(expr, "Expr::While"),
        Expr::ForLoop(_) => unsupported_expr(expr, "Expr::ForLoop"),
        Expr::Closure(_) => unsupported_expr(expr, "Expr::Closure (closure)"),
        Expr::Try(_) => unsupported_expr(expr, "Expr::Try (? operator)"),
        Expr::Unsafe(_) => unsupported_expr(expr, "Expr::Unsafe (unsafe block)"),
        Expr::Await(_) => unsupported_expr(expr, "Expr::Await (async/await)"),
        Expr::Async(_) => unsupported_expr(expr, "Expr::Async (async block)"),
        Expr::Struct(_) => unsupported_expr(expr, "Expr::Struct (struct literal)"),
        Expr::Macro(_) => unsupported_expr(expr, "Expr::Macro (macro invocation)"),
        Expr::Range(_) => unsupported_expr(expr, "Expr::Range"),
        Expr::Reference(_) => unsupported_expr(expr, "Expr::Reference (&expr)"),
        Expr::Cast(_) => unsupported_expr(expr, "Expr::Cast (as cast)"),
        Expr::Assign(_) => unsupported_expr(expr, "Expr::Assign"),
        Expr::Break(_) => unsupported_expr(expr, "Expr::Break"),
        Expr::Continue(_) => unsupported_expr(expr, "Expr::Continue"),
        Expr::Repeat(_) => unsupported_expr(expr, "Expr::Repeat ([x; N])"),
        Expr::Tuple(_) => unsupported_expr(expr, "Expr::Tuple"),
        Expr::Array(_) => unsupported_expr(expr, "Expr::Array"),
        Expr::TryBlock(_) => unsupported_expr(expr, "Expr::TryBlock"),
        Expr::Yield(_) => unsupported_expr(expr, "Expr::Yield"),
        Expr::Let(_) => unsupported_expr(expr, "Expr::Let (let-chain guard)"),
        Expr::Infer(_) => unsupported_expr(expr, "Expr::Infer (_)"),
        Expr::RawAddr(_) => unsupported_expr(expr, "Expr::RawAddr"),
        _ => {
            let sp = expr.span().start();
            RustExprNode::UnsupportedExpr {
                reason: "Expr::unknown".to_string(),
                line: sp.line,
                col: sp.column + 1,
            }
        }
    }
}

/// Marshal the else-branch of an Expr::If into the RustIfOrelse enum.
fn marshal_if_orelse(else_expr: &Expr) -> RustIfOrelse {
    match else_expr {
        // else if ... -> another IfExpr
        Expr::If(ei) => {
            let sp = ei.span().start();
            let then_branch = marshal_block(&ei.then_branch);
            let orelse = ei.else_branch.as_ref().map(|(_, e)| {
                Box::new(marshal_if_orelse(e))
            });
            RustIfOrelse::IfExpr {
                cond: Box::new(marshal_expr(&ei.cond)),
                then_branch,
                orelse,
                line: sp.line,
                col: sp.column + 1,
            }
        }
        // else { ... } -> plain else block
        Expr::Block(eb) => RustIfOrelse::BlockNode {
            body: marshal_block(&eb.block),
        },
        // Paren wrapping -> unwrap
        Expr::Paren(ep) => marshal_if_orelse(&ep.expr),
        // Fallback: shouldn't occur in valid syn output
        _ => RustIfOrelse::BlockNode {
            body: RustBodyNode { stmts: vec![] },
        },
    }
}

/// Build an UnsupportedExpr node for a deferred expression variant.
fn unsupported_expr(expr: &Expr, reason: &str) -> RustExprNode {
    let sp = expr.span().start();
    RustExprNode::UnsupportedExpr {
        reason: reason.to_string(),
        line: sp.line,
        col: sp.column + 1,
    }
}

/// Return (line, col) from a statement's span.
fn stmt_span_start(stmt: &Stmt) -> (usize, usize) {
    let sp = stmt.span().start();
    (sp.line, sp.column + 1)
}

/// Map syn::BinOp to the canonical operator text string.
///
/// All BinOp variants are mapped so the wire always has the operator text.
/// The raiser (raise-body.ts) restricts its allowed set via ALLOWED_BINARY_OPS
/// and throws RustUnsupportedConstructError for any op outside that set.
fn binop_to_str(op: &BinOp) -> &'static str {
    match op {
        BinOp::Add(_) => "+",
        BinOp::Sub(_) => "-",
        BinOp::Mul(_) => "*",
        BinOp::Div(_) => "/",
        BinOp::Rem(_) => "%",
        BinOp::And(_) => "&&",
        BinOp::Or(_) => "||",
        BinOp::BitXor(_) => "^",
        BinOp::BitAnd(_) => "&",
        BinOp::BitOr(_) => "|",
        BinOp::Shl(_) => "<<",
        BinOp::Shr(_) => ">>",
        BinOp::Eq(_) => "==",
        BinOp::Lt(_) => "<",
        BinOp::Le(_) => "<=",
        BinOp::Ne(_) => "!=",
        BinOp::Ge(_) => ">=",
        BinOp::Gt(_) => ">",
        BinOp::AddAssign(_) => "+=",
        BinOp::SubAssign(_) => "-=",
        BinOp::MulAssign(_) => "*=",
        BinOp::DivAssign(_) => "/=",
        BinOp::RemAssign(_) => "%=",
        BinOp::BitXorAssign(_) => "^=",
        BinOp::BitAndAssign(_) => "&=",
        BinOp::BitOrAssign(_) => "|=",
        BinOp::ShlAssign(_) => "<<=",
        BinOp::ShrAssign(_) => ">>=",
        _ => "unknown_op",
    }
}

/// Return a short description string for an unsupported pattern kind.
fn pat_kind(pat: &Pat) -> &'static str {
    match pat {
        Pat::Const(_) => "Pat::Const",
        Pat::Lit(_) => "Pat::Lit",
        Pat::Macro(_) => "Pat::Macro",
        Pat::Or(_) => "Pat::Or",
        Pat::Paren(_) => "Pat::Paren",
        Pat::Path(_) => "Pat::Path",
        Pat::Range(_) => "Pat::Range",
        Pat::Reference(_) => "Pat::Reference",
        Pat::Rest(_) => "Pat::Rest",
        Pat::Slice(_) => "Pat::Slice",
        Pat::Struct(_) => "Pat::Struct",
        Pat::Tuple(_) => "Pat::Tuple",
        Pat::TupleStruct(_) => "Pat::TupleStruct",
        Pat::Type(_) => "Pat::Type",
        Pat::Verbatim(_) => "Pat::Verbatim",
        _ => "Pat::unknown",
    }
}

// ---------------------------------------------------------------------------
// Helpers (carried from slice 1)
// ---------------------------------------------------------------------------

/// Extract a simple identifier name from a parameter pattern.
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

/// Convert a syn Type to a source string, normalised for idiomatic Rust notation.
fn type_to_string(ty: &Type) -> String {
    use syn::__private::ToTokens;
    let tokens = ty.to_token_stream().to_string();
    normalise_type_string(&tokens)
}

/// Normalise whitespace in a syn-generated type string.
///
/// syn's token stream adds spaces in places humans don't:
///   "& str"        -> "&str"
///   "& 'a str"     -> "&'a str"
///   "Vec < i32 >"  -> "Vec<i32>"
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

/// Extract the body of a function block as a source string (for diagnostics).
fn block_to_source(block: &syn::Block) -> String {
    use syn::__private::ToTokens;
    let tokens = block.to_token_stream().to_string();
    let inner = tokens
        .trim_start_matches('{')
        .trim_end_matches('}')
        .trim();
    inner.to_string()
}
