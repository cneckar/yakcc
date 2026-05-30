# SPDX-License-Identifier: MIT
#
# libcst-parse.py — emit a JSON-AST envelope for the Python source on stdin.
# WI-782 slice 4: full MVP mapping table — adds IfExp (ternary), LenCall,
# ListComp (map/filter patterns), Raise statement, and general Call.
# Also emits module-level imports for purity-check.ts.
#
# WI-888: SmallStatement Expr handling — adds Docstring + ImpureStatement
# wire nodes emitted by _stmt_inner() when it encounters libcst.Expr nodes.
# See PLAN.md §3 and DEC-WI888-001..003.
#
# Wire shape (cumulative through WI-888):
#   functions[].body:
#     [ Statement, ... ]
#   Statement:
#     {"type": "Return", "value": <Expr> | null}
#     {"type": "Pass"}
#     {"type": "Raise", "excClass": "<str>", "message": <Expr> | null}  [slice 4]
#     {"type": "Docstring", "value": "<str>"}                           [WI-888]
#     {"type": "ImpureStatement", "construct": "bare_call"|            [WI-888]
#              "bare_expression", "detail": "<str>"}
#     {"type": "Unsupported", "reason": "<str>"}
#   Expr:
#     {"type": "Name",    "name": "<str>"}
#     {"type": "Integer", "value": "<str>"}   # str to preserve precision
#     {"type": "Float",   "value": "<str>"}
#     {"type": "String",  "value": "<str>"}   # already unescaped
#     {"type": "Bool",    "value": true|false}
#     {"type": "None"}
#     {"type": "BinaryOp", "op": "<str>", "left": <Expr>, "right": <Expr>}
#     {"type": "UnaryOp",  "op": "<str>", "operand": <Expr>}            [slice 4]
#     {"type": "IfExp",  "test": <Expr>, "body": <Expr>, "orelse": <Expr>} [s4]
#     {"type": "LenCall", "arg": <Expr>}                                [slice 4]
#     {"type": "Call", "func": "<str>", "args": [<Expr>, ...]}          [slice 4]
#     {"type": "ListComp", "kind": "map", "iter": <Expr>,               [slice 4]
#              "param": "<str>", "elt": <Expr>}
#     {"type": "ListComp", "kind": "filter", "iter": <Expr>,            [slice 4]
#              "param": "<str>", "cond": <Expr>}
#     {"type": "Unsupported", "reason": "<str>"}
#
# Exit codes (unchanged from slice 1):
#   0 — success
#   1 — libcst missing
#   2 — parse failure

import json
import sys


def _annotation_text(node, module=None):  # type: ignore[no-untyped-def]
    if node is None:
        return None
    # Prefer module.code_for_node (works for all expression nodes)
    if module is not None:
        try:
            return module.code_for_node(node).strip()
        except Exception:  # noqa: BLE001
            pass
    # Fallback: some composite nodes (IndentedBlock, etc.) expose .code directly
    try:
        return node.code.strip()
    except AttributeError:
        return None


# Python → "wire op string" map for libcst BinaryOperation operator nodes.
BINARY_OP_MAP = {
    "Add": "+",
    "Subtract": "-",
    "Multiply": "*",
    "Divide": "/",
    "FloorDivide": "//",  # WI-875: Python a//b — TS renders as Math.floor(a/b)
    "Modulo": "%",
    "Equal": "==",
    "NotEqual": "!=",
    "LessThan": "<",
    "GreaterThan": ">",
    "LessThanEqual": "<=",
    "GreaterThanEqual": ">=",
}

# Slice 4: unary op map (libcst class name → TS op string)
UNARY_OP_MAP = {
    "Minus": "-",
    "Plus": "+",
    "Not": "!",
    "BitInvert": "~",
}


def _callee_name(node):  # type: ignore[no-untyped-def]
    """Extract a simple dotted name from a libcst Attribute or Name callee."""
    import libcst  # type: ignore[import-untyped]

    if isinstance(node, libcst.Name):
        return node.value
    if isinstance(node, libcst.Attribute):
        obj = _callee_name(node.value)
        attr = node.attr.value if isinstance(node.attr, libcst.Name) else None
        if obj and attr:
            return f"{obj}.{attr}"
    return None


def _expr(node):  # type: ignore[no-untyped-def]
    """Translate a libcst expression node into a wire-Expr dict."""
    import libcst  # type: ignore[import-untyped]

    if isinstance(node, libcst.Name):
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

    if isinstance(node, libcst.UnaryOperation):
        op_name = type(node.operator).__name__
        if op_name not in UNARY_OP_MAP:
            return {"type": "Unsupported", "reason": f"UnaryOperation {op_name}"}
        return {
            "type": "UnaryOp",
            "op": UNARY_OP_MAP[op_name],
            "operand": _expr(node.expression),
        }

    if isinstance(node, libcst.Comparison):
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

    # Slice 4: ternary `body if test else orelse` → IfExp
    if isinstance(node, libcst.IfExp):
        return {
            "type": "IfExp",
            "test": _expr(node.test),
            "body": _expr(node.body),
            "orelse": _expr(node.orelse),
        }

    # Slice 4: function calls
    if isinstance(node, libcst.Call):
        func = node.func
        # Special case: `len(x)` → LenCall
        if isinstance(func, libcst.Name) and func.value == "len" and len(node.args) == 1:
            first_arg = node.args[0].value
            return {"type": "LenCall", "arg": _expr(first_arg)}
        # General call with a simple dotted name callee
        func_name = _callee_name(func)
        if func_name is not None:
            args = [_expr(a.value) for a in node.args if not a.star]
            return {"type": "Call", "func": func_name, "args": args}
        return {"type": "Unsupported", "reason": "Call with complex callee"}

    # Slice 4: list comprehension [elt for var in iter (if cond)]
    # libcst: node.for_in is a single CompFor, not a list.
    # Nested generators chain via CompFor.inner_for_in.
    if isinstance(node, libcst.ListComp):
        gen = node.for_in
        # Reject multiple generators (chained for_in via inner_for_in)
        if gen.inner_for_in is not None:
            return {"type": "Unsupported", "reason": "ListComp with multiple generators"}
        # The loop variable must be a simple Name
        if not isinstance(gen.target, libcst.Name):
            return {"type": "Unsupported", "reason": "ListComp with tuple/complex target"}
        param = gen.target.value
        iter_expr = _expr(gen.iter)
        # Map pattern: `[f(x) for x in xs]` — no ifs, elt is any expr
        if len(gen.ifs) == 0:
            return {
                "type": "ListComp",
                "kind": "map",
                "iter": iter_expr,
                "param": param,
                "elt": _expr(node.elt),
            }
        # Filter pattern: `[x for x in xs if p(x)]` — single if, elt == param
        if len(gen.ifs) == 1 and isinstance(node.elt, libcst.Name) and node.elt.value == param:
            return {
                "type": "ListComp",
                "kind": "filter",
                "iter": iter_expr,
                "param": param,
                "cond": _expr(gen.ifs[0].test),
            }
        return {
            "type": "Unsupported",
            "reason": ("ListComp: complex pattern (multiple ifs or non-identity elt with filter)"),
        }

    return {"type": "Unsupported", "reason": type(node).__name__}


# ---------------------------------------------------------------------------
# WI-888: helpers for SmallStatement Expr detection
# ---------------------------------------------------------------------------


def _docstring_text(value):  # type: ignore[no-untyped-def]
    """Extract unquoted text from a string-literal libcst node.

    @decision DEC-WI888-001 — Emit Docstring wire node (Option A)
    @title Docstring detection emits {"type":"Docstring"} into the wire envelope
    @status accepted
    @rationale The wire envelope is the canonical record; downstream tooling
      (compile-python, doc extraction, future lint) may want the docstring value.
      Emitting is additive and free. TS renderStmt silently discards the node.
      Cross-reference: PLAN.md §4 / #888
    """
    import libcst  # type: ignore[import-untyped]

    if isinstance(value, libcst.SimpleString):
        raw = value.value
        # Strip one layer of matching quotes (handles 'x', "x", '''x''', \"\"\"x\"\"\")
        for prefix_len in (3, 1):
            for q in ('"""', "'''", '"', "'"):
                if len(q) == prefix_len and raw.startswith(q) and raw.endswith(q):
                    return raw[len(q) : -len(q)]
        return raw
    if isinstance(value, libcst.ConcatenatedString):
        # PEP-257 allows implicit concatenation; join the parts
        parts = []
        node: libcst.BaseExpression = value  # type: ignore[assignment]
        while isinstance(node, libcst.ConcatenatedString):
            parts.append(_docstring_text(node.right))
            node = node.left
        parts.append(_docstring_text(node))
        return "".join(reversed(parts))
    # FormattedString (f-string docstring — rare but legal PEP-257)
    # Fall back to libcst's code representation trimmed of the f"..." wrapper.
    try:
        return value.code.strip()
    except AttributeError:
        return repr(value)


def _bare_call_repr(call):  # type: ignore[no-untyped-def]
    """Produce a short human-readable call string like 'print(...)'.

    @decision DEC-WI888-002 — Bare-call detection via Expr(Call)
    @title Expr(Call) emits ImpureStatement(bare_call) with callee name + (...)
    @status accepted
    @rationale detail is for error messages only — no argument rendering needed.
      Cross-reference: PLAN.md §4 / #888
    """
    name = _callee_name(call.func)
    if name is not None:
        return f"{name}(...)"
    return "<complex-callee>(...)"


def _stmt_inner(inner, is_first=False):  # type: ignore[no-untyped-def]
    """Translate a libcst SmallStatement into a wire Statement dict.

    is_first: True when this is the first statement of a function body;
    required for PEP-257 docstring detection (DEC-WI888-001).
    """
    import libcst  # type: ignore[import-untyped]

    if isinstance(inner, libcst.Return):
        return {
            "type": "Return",
            "value": _expr(inner.value) if inner.value is not None else None,
        }
    if isinstance(inner, libcst.Pass):
        return {"type": "Pass"}
    # Slice 4: raise ExcClass("…")
    if isinstance(inner, libcst.Raise):
        exc = inner.exc
        if exc is None:
            return {"type": "Unsupported", "reason": "bare raise"}
        # Must be a Call: `ExcClass(...)` or `module.ExcClass(...)`
        if isinstance(exc, libcst.Call):
            exc_name = _callee_name(exc.func)
            if exc_name is None:
                return {"type": "Unsupported", "reason": "raise with complex callee"}
            msg_expr = None
            if len(exc.args) == 1:
                msg_expr = _expr(exc.args[0].value)
            elif len(exc.args) > 1:
                return {"type": "Unsupported", "reason": "raise with multiple args"}
            return {"type": "Raise", "excClass": exc_name, "message": msg_expr}
        return {
            "type": "Unsupported",
            "reason": f"raise with non-call exc: {type(exc).__name__}",
        }

    # WI-888: SmallStatement Expr — three shapes:
    #   1. Docstring  — first stmt + string-literal value   → Docstring node
    #   2. Bare call  — Expr(Call)                          → ImpureStatement(bare_call)
    #   3. Other expr — Expr(*) catch-all                   → ImpureStatement(bare_expression)
    #
    # @decision DEC-WI888-003 — Catch-all bare-expression detection
    # @title Any Expr(*) that is not docstring/call is ImpureStatement(bare_expression)
    # @status accepted
    # @rationale Dead code or side-effecting __getattr__; neither is acceptable
    #   in a pure-function shave context. Cross-reference: PLAN.md §4 / #888
    if isinstance(inner, libcst.Expr):
        value = inner.value
        # 1. Docstring: first stmt + string-literal expression
        if is_first and isinstance(
            value,
            (libcst.SimpleString, libcst.ConcatenatedString, libcst.FormattedString),
        ):
            text = _docstring_text(value)
            return {"type": "Docstring", "value": text}
        # 2. Bare call: print(x), parser.feed(data), sys.stdout.write(...)
        if isinstance(value, libcst.Call):
            detail = _bare_call_repr(value)
            return {
                "type": "ImpureStatement",
                "construct": "bare_call",
                "detail": detail,
            }
        # 3. Other bare expression-statements: x + y, obj.attr, x and y, ...
        return {
            "type": "ImpureStatement",
            "construct": "bare_expression",
            "detail": type(value).__name__,
        }

    return {"type": "Unsupported", "reason": f"SmallStatement {type(inner).__name__}"}


def _stmt_v2(node, is_first=False):  # type: ignore[no-untyped-def]
    """Translate a libcst statement node into a wire Statement dict (slice 4).

    is_first: plumbed through from _function_envelope to _stmt_inner so that
    docstring detection (DEC-WI888-001) only fires on the first body statement.
    """
    import libcst  # type: ignore[import-untyped]

    if isinstance(node, libcst.SimpleStatementLine):
        if len(node.body) != 1:
            return {"type": "Unsupported", "reason": "Multi-statement simple line"}
        return _stmt_inner(node.body[0], is_first=is_first)
    return {"type": "Unsupported", "reason": type(node).__name__}


def _collect_imports(module):  # type: ignore[no-untyped-def]
    """Collect top-level import declarations for purity-check.ts."""
    import libcst  # type: ignore[import-untyped]

    imports = []
    for stmt in module.body:
        if isinstance(stmt, libcst.SimpleStatementLine):
            for small in stmt.body:
                if isinstance(small, libcst.Import):
                    names_iter = small.names if isinstance(small.names, (list, tuple)) else []
                    for name in names_iter:
                        alias = getattr(name, "asname", None)
                        alias_str = alias.name.value if alias and hasattr(alias, "name") else None
                        n_val = name.name.value if hasattr(name.name, "value") else str(name.name)
                        imports.append(
                            {
                                "kind": "import",
                                "module": n_val,
                                "name": n_val,
                                "alias": alias_str,
                            }
                        )
                elif isinstance(small, libcst.ImportFrom):
                    mod = small.module
                    mod_name = (
                        (
                            mod.value
                            if isinstance(mod, libcst.Name)
                            else (mod.code if hasattr(mod, "code") else str(mod))
                        )
                        if mod
                        else ""
                    )
                    names = small.names
                    if isinstance(names, (list, tuple)):
                        for n in names:
                            n_name = n.name.value if hasattr(n.name, "value") else str(n.name)
                            imports.append(
                                {
                                    "kind": "from",
                                    "module": mod_name,
                                    "name": n_name,
                                }
                            )
                    else:
                        imports.append({"kind": "from", "module": mod_name, "name": "*"})
    return imports


def _function_envelope(fn, module=None):  # type: ignore[no-untyped-def]
    params = [
        {
            "name": p.name.value,
            "annotation": (
                _annotation_text(p.annotation.annotation, module)
                if p.annotation is not None
                else None
            ),
        }
        for p in fn.params.params
    ]
    return_annot = (
        _annotation_text(fn.returns.annotation, module) if fn.returns is not None else None
    )
    try:
        body_source = fn.body.code.rstrip("\n")
    except AttributeError:
        body_source = ""

    body = []
    try:
        # WI-888: pass is_first so _stmt_inner can detect docstrings in
        # the first statement of the function body (DEC-WI888-001).
        for idx, stmt in enumerate(fn.body.body):
            body.append(_stmt_v2(stmt, is_first=(idx == 0)))
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

    functions = [
        _function_envelope(s, module) for s in module.body if isinstance(s, libcst.FunctionDef)
    ]
    imports = _collect_imports(module)
    json.dump(
        {
            "version": 1,
            "module": {
                "type": type(module).__name__,
                "stmt_count": len(module.body),
                "functions": functions,
                "imports": imports,
            },
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
