# SPDX-License-Identifier: MIT
#
# libcst-parse.py — emit a JSON-AST envelope for the Python source on stdin.
# WI-782 slice 2b: body[] now ships structured statement nodes (Return, Pass)
# with expression sub-trees (Name, Integer, Float, String, Bool, None,
# BinaryOp).  body_source remains for backward-compat with slice-2 callers.
# Out of scope for 2b: if/for/while, function calls, comprehensions — slice 3+.
#
# Wire shape (slice 2b additions):
#   functions[].body:
#     [ Statement, ... ]
#   Statement:
#     {"type": "Return", "value": <Expr> | null}
#     {"type": "Pass"}
#     {"type": "Unsupported", "reason": "<str>"}
#   Expr:
#     {"type": "Name",    "name": "<str>"}
#     {"type": "Integer", "value": "<str>"}   # str to preserve precision
#     {"type": "Float",   "value": "<str>"}
#     {"type": "String",  "value": "<str>"}   # already unescaped
#     {"type": "Bool",    "value": true|false}
#     {"type": "None"}
#     {"type": "BinaryOp", "op": "<str>", "left": <Expr>, "right": <Expr>}
#     {"type": "Unsupported", "reason": "<str>"}
#
# Exit codes (unchanged from slice 1):
#   0 — success
#   1 — libcst missing
#   2 — parse failure

import json
import sys


def _annotation_text(node):  # type: ignore[no-untyped-def]
    if node is None:
        return None
    try:
        return node.code.strip()
    except AttributeError:
        return None


# Python → "wire op string" map for libcst BinaryOperation operator nodes.
# We use the libcst class name so we don't have to touch each instance.
BINARY_OP_MAP = {
    "Add": "+",
    "Subtract": "-",
    "Multiply": "*",
    "Divide": "/",
    "Modulo": "%",
    "Equal": "==",
    "NotEqual": "!=",
    "LessThan": "<",
    "GreaterThan": ">",
    "LessThanEqual": "<=",
    "GreaterThanEqual": ">=",
}


def _expr(node):  # type: ignore[no-untyped-def]
    """Translate a libcst expression node into a wire-Expr dict."""
    import libcst  # type: ignore[import-untyped]

    if isinstance(node, libcst.Name):
        # Python literals True/False/None are also Name nodes in libcst.
        if node.value == "True":
            return {"type": "Bool", "value": True}
        if node.value == "False":
            return {"type": "Bool", "value": False}
        if node.value == "None":
            return {"type": "None"}
        return {"type": "Name", "name": node.value}
    if isinstance(node, libcst.Integer):
        return {"type": "Integer", "value": node.value}
    if isinstance(node, libcst.Float):
        return {"type": "Float", "value": node.value}
    if isinstance(node, libcst.SimpleString):
        # libcst gives us the raw literal including quotes; strip them.
        raw = node.value
        if len(raw) >= 2 and raw[0] in ('"', "'") and raw[-1] == raw[0]:
            inner = raw[1:-1]
        else:
            inner = raw
        return {"type": "String", "value": inner}
    if isinstance(node, libcst.BinaryOperation):
        op_name = type(node.operator).__name__
        if op_name not in BINARY_OP_MAP:
            return {"type": "Unsupported", "reason": f"BinaryOperation {op_name}"}
        return {
            "type": "BinaryOp",
            "op": BINARY_OP_MAP[op_name],
            "left": _expr(node.left),
            "right": _expr(node.right),
        }
    if isinstance(node, libcst.Comparison):
        # Single comparator (`a < b`) only — chained Python comparisons (`a < b < c`)
        # are deferred to a future slice as they have no direct TS equivalent.
        if len(node.comparisons) != 1:
            return {
                "type": "Unsupported",
                "reason": f"Chained comparison ({len(node.comparisons)} operators)",
            }
        target = node.comparisons[0]
        op_name = type(target.operator).__name__
        if op_name not in BINARY_OP_MAP:
            return {"type": "Unsupported", "reason": f"Comparison {op_name}"}
        return {
            "type": "BinaryOp",
            "op": BINARY_OP_MAP[op_name],
            "left": _expr(node.left),
            "right": _expr(target.comparator),
        }
    return {"type": "Unsupported", "reason": type(node).__name__}


def _stmt(node):  # type: ignore[no-untyped-def]
    import libcst  # type: ignore[import-untyped]

    if isinstance(node, libcst.SimpleStatementLine):
        if len(node.body) != 1:
            return {"type": "Unsupported", "reason": "Multi-statement simple line"}
        inner = node.body[0]
        if isinstance(inner, libcst.Return):
            return {"type": "Return", "value": _expr(inner.value) if inner.value is not None else None}
        if isinstance(inner, libcst.Pass):
            return {"type": "Pass"}
        return {"type": "Unsupported", "reason": f"SimpleStatement {type(inner).__name__}"}
    return {"type": "Unsupported", "reason": type(node).__name__}


def _function_envelope(fn):  # type: ignore[no-untyped-def]
    params = [
        {
            "name": p.name.value,
            "annotation": _annotation_text(p.annotation.annotation) if p.annotation is not None else None,
        }
        for p in fn.params.params
    ]
    return_annot = _annotation_text(fn.returns.annotation) if fn.returns is not None else None
    try:
        body_source = fn.body.code.rstrip("\n")
    except AttributeError:
        body_source = ""

    body = []
    try:
        for stmt in fn.body.body:
            body.append(_stmt(stmt))
    except AttributeError:
        pass

    return {
        "name": fn.name.value,
        "params": params,
        "return_annotation": return_annot,
        "body_source": body_source,
        "body": body,
    }


def main() -> int:
    try:
        import libcst  # type: ignore[import-untyped]
    except ImportError as exc:
        print(f"libcst is not installed: {exc}. Run: pip install libcst", file=sys.stderr)
        return 1

    source = sys.stdin.read()
    try:
        module = libcst.parse_module(source)
    except libcst.ParserSyntaxError as exc:
        print(f"libcst parse error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"libcst unexpected error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    functions = [_function_envelope(s) for s in module.body if isinstance(s, libcst.FunctionDef)]
    json.dump(
        {
            "version": 1,
            "module": {
                "type": type(module).__name__,
                "stmt_count": len(module.body),
                "functions": functions,
            },
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
