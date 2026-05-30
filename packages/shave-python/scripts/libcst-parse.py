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
# WI-903: If statement support — _stmt_v2() now handles libcst.If compound
# statements, emitting {"type":"If","test":<Expr>,"body":[...],"orelse":[...]}
# where orelse is [] (no else), a flat list (else block), or [{type:"If",...}]
# (elif chain, matching Python AST convention). Cross-reference: #903.
#
# WI-904: Comprehension support — _expr() handles GeneratorExp, DictComp,
# SetComp with single-source single-clause MVP. Multi-clause raises Unsupported.
# Cross-reference: #904.
#
# WI-907: Assign (single-target name) — _stmt_inner() detects libcst.Assign
# with a single AssignTarget whose target is a libcst.Name and emits:
# {"type": "Assign", "target": "<name>", "value": <Expr>}
# Multi-target, tuple-unpack, attribute-assign, subscript-assign, augmented
# assign all emit Unsupported with specific messages. Cross-reference: #907.
#
# WI-908: BooleanOperation — _expr() detects libcst.BooleanOperation and emits:
# {"type": "BoolOp", "op": "and"|"or", "left": <Expr>, "right": <Expr>}
# Cross-reference: #908.
#
# WI-909: Comprehension tuple target — comprehension renderers (ListComp,
# GeneratorExp, DictComp, SetComp) now handle libcst.Tuple targets, emitting:
# {"target_kind": "tuple", "target_names": ["k", "v"]} alongside existing
# "param" field (set to joined names for backward compat). Nested tuples and
# star targets still emit Unsupported. Cross-reference: #909.
#
# WI-911: Subscript (obj[key]) — _expr() detects libcst.Subscript.
# Single Index slice emits {"type": "Subscript", "value": <Expr>, "slice": <Expr>}.
# libcst.Slice notation and multi-index (m[i,j]) are rejected as Unsupported.
# Cross-reference: #911.
#
# WI-912: Comparison Is / IsNot — adds libcst.Is and libcst.IsNot to the
# comparator dispatch in _expr(). Is → "is", IsNot → "is_not".
# TS renderer maps `is None` → `=== null`, `is_not None` → `!== null`.
# Non-None identity comparisons emit strict-equality with a comment.
# Cross-reference: #912.
#
# WI-913: Tuple value — _expr() detects libcst.Tuple (not as a comprehension
# target but as an expression). Emits {"type": "Tuple", "elements": [<Expr>...]}.
# TS renderer lowers to `[<expr>, ...]` (JS array literal).
# Empty tuple → `[]`; single-element `(a,)` → `[a]`. Cross-reference: #913.
#
# WI-890: Class method extraction — _function_envelope walks one level of
# ClassDef inside the module body.  Each FunctionDef found in a class body is
# emitted into module.functions[] with:
#   "name":       "ClassName.methodName"  (dotted — avoids name collisions)
#   "methodKind": "static" | "class" | "instance"
# The "methodKind" field is absent on module-level functions to preserve
# byte-equivalence of all existing callers.  Detection rules:
#   @staticmethod → "static"   (treated as a pure module-level fn downstream)
#   @classmethod  → "class"    (cls param; purity check allows it)
#   no decorator  → "instance" (self param; tagged impure downstream)
# Cross-reference: PLAN.md §WI-890 / DEC-WI890-001..010
#
# WI-905: Nested FunctionDef rejection — _stmt_v2() detects libcst.FunctionDef
# as a compound statement inside a function body and emits ImpureStatement with
# construct "nested_function" instead of the generic Unsupported wire node.
# This reuses the existing WI-888 ImpureStatement wire shape; no new wire type.
# TS raise-body.ts throws ImpureFunctionError(kind:'forbidden_construct') with
# a message mentioning "nested function definition (closure) — not supported in
# MVP, refactor to module-level". Cross-reference: #905.
#
# WI-931: bare Attribute access (obj.attr as expression value) — _expr() now emits
# {"type":"Attribute","value":<Expr>,"attr":"<str>"} for libcst.Attribute nodes that
# appear outside of a Call callee.  Previously, Attribute was silently swallowed by
# _callee_name and only worked inside Call.  Adding a first-class Attribute wire node
# makes bare access (`cls.CONSTANT`, `obj.attr` as return value, argument, etc.) render
# correctly in raise-body.ts.  Cross-reference: #931.
#
# WI-932: Comparison In / NotIn membership operators — COMPARE_OP_MAP now includes
# libcst.In → "in" and libcst.NotIn → "not_in".  The TS renderer maps these to
# right.includes(left) and !right.includes(left) respectively, covering the common
# string/array membership case.  Cross-reference: #932.
#
# Wire shape (cumulative through WI-932):
#     [ Statement, ... ]
#   Statement:
#     {"type": "Return", "value": <Expr> | null}
#     {"type": "Pass"}
#     {"type": "Raise", "excClass": "<str>", "message": <Expr> | null}  [slice 4]
#     {"type": "Docstring", "value": "<str>"}                           [WI-888]
#     {"type": "ImpureStatement", "construct": "bare_call"|            [WI-888]
#              "bare_expression", "detail": "<str>"}
#     {"type": "ImpureStatement", "construct": "nested_function",      [WI-905]
#              "detail": "<str>"}
#     {"type": "If", "test": <Expr>, "body": [<Stmt>...],              [WI-903]
#              "orelse": [<Stmt>...]}
#     {"type": "Assign", "target": "<name>", "value": <Expr>}          [WI-907]
#     {"type": "Unsupported", "reason": "<str>"}
#   Expr:
#     {"type": "Name",    "name": "<str>"}
#     {"type": "Integer", "value": "<str>"}   # str to preserve precision
#     {"type": "Float",   "value": "<str>"}
#     {"type": "String",  "value": "<str>"}   # already unescaped
#     {"type": "Bool",    "value": true|false}
#     {"type": "None"}
#     {"type": "BinaryOp", "op": "<str>", "left": <Expr>, "right": <Expr>}
#     {"type": "BoolOp", "op": "and"|"or", "left": <Expr>, "right": <Expr>} [WI-908]
#     {"type": "UnaryOp",  "op": "<str>", "operand": <Expr>}            [slice 4]
#     {"type": "IfExp",  "test": <Expr>, "body": <Expr>, "orelse": <Expr>} [s4]
#     {"type": "LenCall", "arg": <Expr>}                                [slice 4]
#     {"type": "Call", "func": "<str>", "args": [<Expr>, ...]}          [slice 4]
#     {"type": "ListComp", "kind": "map", "iter": <Expr>,               [slice 4]
#              "param": "<str>", "elt": <Expr>}
#     {"type": "ListComp", "kind": "filter", "iter": <Expr>,            [slice 4]
#              "param": "<str>", "cond": <Expr>}
#     {"type": "GeneratorExp", "kind": "map"|"filter_map",              [WI-904]
#              "iter": <Expr>, "param": "<str>", "elt": <Expr>,
#              "cond": <Expr>?,
#              "target_kind"?: "tuple", "target_names"?: [<str>,...]}   [WI-909]
#     {"type": "DictComp", "iter": <Expr>, "param": "<str>",            [WI-904]
#              "keyElt": <Expr>, "valElt": <Expr>, "cond": <Expr>|null,
#              "target_kind"?: "tuple", "target_names"?: [<str>,...]}   [WI-909]
#     {"type": "SetComp", "kind": "map"|"filter_map",                   [WI-904]
#              "iter": <Expr>, "param": "<str>", "elt": <Expr>,
#              "cond": <Expr>?,
#              "target_kind"?: "tuple", "target_names"?: [<str>,...]}   [WI-909]
#     {"type": "Attribute", "value": <Expr>, "attr": "<str>"}           [WI-931]
#     {"type": "Subscript", "value": <Expr>, "slice": <Expr>}           [WI-911]
#     {"type": "Tuple", "elements": [<Expr>, ...]}                      [WI-913]
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

# WI-912: identity comparison operators emitted by libcst Comparison nodes.
# Separate from BINARY_OP_MAP because they require Comparison, not BinaryOperation.
COMPARE_OP_MAP = {
    "Equal": "==",
    "NotEqual": "!=",
    "LessThan": "<",
    "GreaterThan": ">",
    "LessThanEqual": "<=",
    "GreaterThanEqual": ">=",
    "Is": "is",  # WI-912: `x is y` — TS: === (None→null, else strict-eq)
    "IsNot": "is_not",  # WI-912: `x is not y` — TS: !== (None→null, else strict-neq)
    "In": "in",  # WI-932: `x in y` — TS: y.includes(x)
    "NotIn": "not_in",  # WI-932: `x not in y` — TS: !y.includes(x)
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


def _name_of(node):  # type: ignore[no-untyped-def]
    """Extract a plain identifier string from a libcst Name node, or None."""
    import libcst  # type: ignore[import-untyped]

    if isinstance(node, libcst.Name):
        return node.value
    return None


def _tuple_target_names(tup):  # type: ignore[no-untyped-def]
    """Extract flat name list from a libcst.Tuple target.

    WI-909: comprehension tuple-target support.

    Returns a list of str on success, or None when the tuple contains a
    non-Name element (nested tuple, star, etc.) so the caller can emit
    an Unsupported node instead.

    Only one level of destructuring is supported (no nested tuples).
    """
    import libcst  # type: ignore[import-untyped]

    names = []
    for elt in tup.elements:
        # StarredElement is never allowed
        if isinstance(elt, libcst.StarredElement):
            return None
        name = _name_of(elt.value)
        if name is None:
            # Nested tuple or any non-Name element — reject
            return None
        names.append(name)
    return names if names else None


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

    # WI-908: boolean and/or — libcst.BooleanOperation has .left, .operator, .right.
    # Operator is libcst.And or libcst.Or. Python and/or return the operand value
    # (not strictly bool); TS && / || have the same short-circuit semantics.
    if isinstance(node, libcst.BooleanOperation):
        op_cls = type(node.operator).__name__
        if op_cls == "And":
            op_str = "and"
        elif op_cls == "Or":
            op_str = "or"
        else:
            return {"type": "Unsupported", "reason": f"BooleanOperation {op_cls}"}
        return {
            "type": "BoolOp",
            "op": op_str,
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
        if op_name not in COMPARE_OP_MAP:
            return {"type": "Unsupported", "reason": f"Comparison {op_name}"}
        # WI-912: Is / IsNot use the same BinaryOp wire shape; the op string
        # "is" / "is_not" signals identity semantics to the TS renderer.
        return {
            "type": "BinaryOp",
            "op": COMPARE_OP_MAP[op_name],
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
        # WI-909: handle tuple target `for k, v in items`
        if isinstance(gen.target, libcst.Tuple):
            tnames = _tuple_target_names(gen.target)
            if tnames is None:
                return {"type": "Unsupported", "reason": "ListComp with nested/star tuple target"}
            param = ", ".join(tnames)
            iter_expr = _expr(gen.iter)
            base: dict = {  # type: ignore[type-arg]
                "type": "ListComp",
                "kind": "map",
                "iter": iter_expr,
                "param": param,
                "target_kind": "tuple",
                "target_names": tnames,
                "elt": _expr(node.elt),
            }
            if len(gen.ifs) == 1:
                base["kind"] = "filter_map"
                base["cond"] = _expr(gen.ifs[0].test)
            elif len(gen.ifs) > 1:
                return {"type": "Unsupported", "reason": "ListComp with multiple if-clauses"}
            return base
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

    # WI-904: generator expression (x for target in iter [if cond])
    # Lowers identically to ListComp — TS consumer receives an Array.
    if isinstance(node, libcst.GeneratorExp):
        gen = node.for_in
        if gen.inner_for_in is not None:
            return {"type": "Unsupported", "reason": "GeneratorExp with multiple generators"}
        # WI-909: handle tuple target `for k, v in items`
        if isinstance(gen.target, libcst.Tuple):
            tnames = _tuple_target_names(gen.target)
            if tnames is None:
                return {
                    "type": "Unsupported",
                    "reason": "GeneratorExp with nested/star tuple target",
                }
            param = ", ".join(tnames)
            iter_expr = _expr(gen.iter)
            gbase: dict = {  # type: ignore[type-arg]
                "type": "GeneratorExp",
                "kind": "map",
                "iter": iter_expr,
                "param": param,
                "target_kind": "tuple",
                "target_names": tnames,
                "elt": _expr(node.elt),
            }
            if len(gen.ifs) == 1:
                gbase["kind"] = "filter_map"
                gbase["cond"] = _expr(gen.ifs[0].test)
            elif len(gen.ifs) > 1:
                return {"type": "Unsupported", "reason": "GeneratorExp with multiple if-clauses"}
            return gbase
        if not isinstance(gen.target, libcst.Name):
            return {"type": "Unsupported", "reason": "GeneratorExp with tuple/complex target"}
        param = gen.target.value
        iter_expr = _expr(gen.iter)
        if len(gen.ifs) == 0:
            return {
                "type": "GeneratorExp",
                "kind": "map",
                "iter": iter_expr,
                "param": param,
                "elt": _expr(node.elt),
            }
        if len(gen.ifs) == 1:
            return {
                "type": "GeneratorExp",
                "kind": "filter_map",
                "iter": iter_expr,
                "param": param,
                "cond": _expr(gen.ifs[0].test),
                "elt": _expr(node.elt),
            }
        return {"type": "Unsupported", "reason": "GeneratorExp with multiple if-clauses"}

    # WI-904: dict comprehension {key: val for target in iter [if cond]}
    if isinstance(node, libcst.DictComp):
        gen = node.for_in
        if gen.inner_for_in is not None:
            return {"type": "Unsupported", "reason": "DictComp with multiple generators"}
        # WI-909: handle tuple target `for k, v in items`
        if isinstance(gen.target, libcst.Tuple):
            tnames = _tuple_target_names(gen.target)
            if tnames is None:
                return {"type": "Unsupported", "reason": "DictComp with nested/star tuple target"}
            param = ", ".join(tnames)
            iter_expr = _expr(gen.iter)
            if len(gen.ifs) > 1:
                return {"type": "Unsupported", "reason": "DictComp with multiple if-clauses"}
            cond_expr = _expr(gen.ifs[0].test) if len(gen.ifs) == 1 else None
            return {
                "type": "DictComp",
                "iter": iter_expr,
                "param": param,
                "target_kind": "tuple",
                "target_names": tnames,
                "keyElt": _expr(node.key),
                "valElt": _expr(node.value),
                "cond": cond_expr,
            }
        if not isinstance(gen.target, libcst.Name):
            return {"type": "Unsupported", "reason": "DictComp with tuple/complex target"}
        param = gen.target.value
        iter_expr = _expr(gen.iter)
        cond_expr = _expr(gen.ifs[0].test) if len(gen.ifs) == 1 else None
        if len(gen.ifs) > 1:
            return {"type": "Unsupported", "reason": "DictComp with multiple if-clauses"}
        return {
            "type": "DictComp",
            "iter": iter_expr,
            "param": param,
            "keyElt": _expr(node.key),
            "valElt": _expr(node.value),
            "cond": cond_expr,
        }

    # WI-904: set comprehension {elt for target in iter [if cond]}
    if isinstance(node, libcst.SetComp):
        gen = node.for_in
        if gen.inner_for_in is not None:
            return {"type": "Unsupported", "reason": "SetComp with multiple generators"}
        # WI-909: handle tuple target `for k, v in items`
        if isinstance(gen.target, libcst.Tuple):
            tnames = _tuple_target_names(gen.target)
            if tnames is None:
                return {"type": "Unsupported", "reason": "SetComp with nested/star tuple target"}
            param = ", ".join(tnames)
            iter_expr = _expr(gen.iter)
            sbase: dict = {  # type: ignore[type-arg]
                "type": "SetComp",
                "kind": "map",
                "iter": iter_expr,
                "param": param,
                "target_kind": "tuple",
                "target_names": tnames,
                "elt": _expr(node.elt),
            }
            if len(gen.ifs) == 1:
                sbase["kind"] = "filter_map"
                sbase["cond"] = _expr(gen.ifs[0].test)
            elif len(gen.ifs) > 1:
                return {"type": "Unsupported", "reason": "SetComp with multiple if-clauses"}
            return sbase
        if not isinstance(gen.target, libcst.Name):
            return {"type": "Unsupported", "reason": "SetComp with tuple/complex target"}
        param = gen.target.value
        iter_expr = _expr(gen.iter)
        if len(gen.ifs) == 0:
            return {
                "type": "SetComp",
                "kind": "map",
                "iter": iter_expr,
                "param": param,
                "elt": _expr(node.elt),
            }
        if len(gen.ifs) == 1:
            return {
                "type": "SetComp",
                "kind": "filter_map",
                "iter": iter_expr,
                "param": param,
                "cond": _expr(gen.ifs[0].test),
                "elt": _expr(node.elt),
            }
        return {"type": "Unsupported", "reason": "SetComp with multiple if-clauses"}

    # WI-931: bare Attribute access — obj.attr as an expression value.
    # Attribute IS already handled implicitly inside _callee_name() (for Call
    # callees such as `module.fn(...)`), but that path only extracts a dotted
    # string and never returns a wire node.  When Attribute appears as a
    # *value* — return value, argument, RHS of an assignment, etc. — we must
    # emit a proper Attribute wire node so raise-body.ts can render it.
    #
    # Wire shape: {"type": "Attribute", "value": <Expr>, "attr": "<str>"}
    # where "value" is the object expression and "attr" is the identifier name.
    # Chained access (a.b.c) is handled naturally via recursion: the inner
    # a.b is itself an Attribute node emitted by the recursive _expr(node.value)
    # call, producing nested Attribute wire nodes that render as a.b.c.
    #
    # Note: libcst.Attribute.attr is a libcst.Name; we read .value for the str.
    if isinstance(node, libcst.Attribute):
        attr_name = node.attr.value if isinstance(node.attr, libcst.Name) else None
        if attr_name is None:
            return {"type": "Unsupported", "reason": "Attribute with non-Name attr"}
        return {
            "type": "Attribute",
            "value": _expr(node.value),
            "attr": attr_name,
        }

    # WI-911: obj[key] — libcst.Subscript.
    # .value is the object expr; .slice is a tuple of SubscriptElement.
    # Only single Index slices are supported; libcst.Slice and multi-index
    # (m[i, j]) are rejected with clear messages.
    if isinstance(node, libcst.Subscript):
        if len(node.slice) != 1:
            return {
                "type": "Unsupported",
                "reason": f"Subscript with {len(node.slice)} indices (multi-index not supported)",
            }
        slice_elem = node.slice[0].slice
        if not isinstance(slice_elem, libcst.Index):
            return {
                "type": "Unsupported",
                "reason": f"Subscript with slice notation ({type(slice_elem).__name__})",
            }
        return {
            "type": "Subscript",
            "value": _expr(node.value),
            "slice": _expr(slice_elem.value),
        }

    # WI-913: tuple value (a, b, ...) → {"type": "Tuple", "elements": [...]}
    # Covers all arities including empty () and single-element (a,).
    # StarredElement inside a tuple-value is rejected as Unsupported.
    if isinstance(node, libcst.Tuple):
        elements = []
        for elt in node.elements:
            if isinstance(elt, libcst.StarredElement):
                return {"type": "Unsupported", "reason": "Tuple with starred element (*x)"}
            elements.append(_expr(elt.value))
        return {"type": "Tuple", "elements": elements}

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

    # WI-907: Assign — single-target name binding: `x = expr`
    # Multi-target (`a = b = expr`), tuple-unpack (`a, b = pair`),
    # attribute-assign (`obj.x = expr`), subscript-assign (`d[k] = v`),
    # and augmented assign (`x += 1`) are all rejected with specific messages.
    if isinstance(inner, libcst.Assign):
        # Multi-target: `a = b = expr` has len(targets) > 1
        if len(inner.targets) != 1:
            return {
                "type": "Unsupported",
                "reason": f"multi-target Assign ({len(inner.targets)} targets)",
            }
        tgt = inner.targets[0].target
        if isinstance(tgt, libcst.Tuple):
            return {"type": "Unsupported", "reason": "tuple-unpack Assign"}
        if isinstance(tgt, libcst.Attribute):
            return {"type": "Unsupported", "reason": "attribute Assign"}
        if isinstance(tgt, libcst.Subscript):
            return {"type": "Unsupported", "reason": "subscript Assign"}
        if not isinstance(tgt, libcst.Name):
            return {"type": "Unsupported", "reason": f"Assign with {type(tgt).__name__} target"}
        return {
            "type": "Assign",
            "target": tgt.value,
            "value": _expr(inner.value),
        }

    if isinstance(inner, libcst.AugAssign):
        return {"type": "Unsupported", "reason": "augmented Assign (+=, -=, ...)"}

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


def _if_stmts(body):  # type: ignore[no-untyped-def]
    """Translate an IndentedBlock body into a list of wire Statement dicts.

    Used by _stmt_v2 for if/elif/else branches. is_first is always False for
    nested bodies (docstring detection only applies to top-level function body).
    """
    stmts = []
    try:
        for stmt in body.body:
            stmts.append(_stmt_v2(stmt, is_first=False))
    except AttributeError:
        pass
    return stmts


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

    # WI-903: if/elif/else compound statement.
    #
    # libcst represents:
    #   if cond: body
    #   elif cond2: body2  → stored as node.orelse = libcst.If(...)
    #   else: body3        → stored as node.orelse = libcst.Else(...)
    #
    # Wire convention (matches Python AST): orelse is either:
    #   []                            — no else/elif
    #   [{type:"If",...}]             — elif chain (single nested If)
    #   [<stmt>, ...]                 — else block (flat list of stmts)
    if isinstance(node, libcst.If):
        orelse: list = []  # type: ignore[type-arg]
        if node.orelse is not None:
            if isinstance(node.orelse, libcst.If):
                # elif: recurse — produces a single If wire node
                orelse = [_stmt_v2(node.orelse, is_first=False)]
            elif isinstance(node.orelse, libcst.Else):
                # else: flat list of stmts in the else body
                orelse = _if_stmts(node.orelse.body)
        return {
            "type": "If",
            "test": _expr(node.test),
            "body": _if_stmts(node.body),
            "orelse": orelse,
        }

    # WI-905: nested FunctionDef inside a function body.
    #
    # libcst represents a `def inner(): ...` inside an outer function body as a
    # libcst.FunctionDef compound statement (not a SimpleStatementLine).
    # We catch it here — before the generic fallback — and emit an ImpureStatement
    # so that raise-body.ts throws ImpureFunctionError(kind:"forbidden_construct")
    # with a clear message instead of a generic UnsupportedAstError("FunctionDef").
    #
    # @decision DEC-WI905-001 — Nested FunctionDef → ImpureStatement(nested_function)
    # @title Detect nested def in body; emit ImpureStatement not Unsupported
    # @status accepted
    # @rationale Closures are not supported in the MVP shave corpus. Raising as
    #   ImpureFunctionError (kind:forbidden_construct) gives callers a typed,
    #   actionable error with a clear "refactor to module-level" message, rather
    #   than the opaque UnsupportedAstError("FunctionDef") that previously fired.
    #   Reuses the existing WI-888 ImpureStatement wire shape — no new wire type.
    #   Cross-reference: PLAN.md §WI-905 / #905.
    if isinstance(node, libcst.FunctionDef):
        return {
            "type": "ImpureStatement",
            "construct": "nested_function",
            "detail": (
                f"nested function '{node.name.value}' — "
                "nested function definition (closure) — not supported in MVP, "
                "refactor to module-level"
            ),
        }

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


def _function_envelope(fn, module=None, method_kind=None):  # type: ignore[no-untyped-def]
    """Build a wire envelope dict for a single FunctionDef node.

    WI-890: method_kind is "static" | "class" | "instance" when fn lives
    inside a ClassDef body.  It is None (and therefore absent from the
    output dict) for module-level functions, preserving byte-equivalence
    with all pre-WI-890 callers.
    """
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

    envelope: dict = {  # type: ignore[type-arg]
        "name": fn.name.value,
        "params": params,
        "return_annotation": return_annot,
        "body_source": body_source,
        "body": body,
    }
    # WI-890: only emit methodKind for class methods (absent for module-level fns)
    if method_kind is not None:
        envelope["methodKind"] = method_kind
    return envelope


def _method_kind(fn):  # type: ignore[no-untyped-def]
    """Detect the method kind of a FunctionDef inside a class body.

    WI-890: Inspects the decorators list for @staticmethod / @classmethod.
    Falls back to "instance" when neither decorator is present.

    Returns "static" | "class" | "instance".
    """
    import libcst  # type: ignore[import-untyped]

    for decorator in fn.decorators:
        # decorator.decorator is the expression: Name, Attribute, or Call
        dec_node = decorator.decorator
        dec_name = None
        if isinstance(dec_node, libcst.Name):
            dec_name = dec_node.value
        elif isinstance(dec_node, libcst.Attribute):
            # e.g. builtins.staticmethod (unusual but possible)
            dec_name = dec_node.attr.value if isinstance(dec_node.attr, libcst.Name) else None
        if dec_name == "staticmethod":
            return "static"
        if dec_name == "classmethod":
            return "class"
    return "instance"


def _class_method_envelopes(cls_node, module=None):  # type: ignore[no-untyped-def]
    """Walk one level of a ClassDef body and return a list of function envelopes.

    WI-890: Only direct FunctionDef children are extracted (one level deep).
    Nested classes and other statement types are silently skipped.  Each
    envelope has a dotted "name" ("ClassName.methodName") and a "methodKind"
    field.

    @decision DEC-WI890-001 — One-level ClassDef walk, dotted names
    @title Extract class methods into module.functions[] with dotted names
    @status accepted
    @rationale Dotted names avoid collision between same-named methods in
      different classes and between method names and module-level function
      names.  One level deep keeps the implementation simple — nested classes
      are not a priority for the MVP shave corpus.
    """
    import libcst  # type: ignore[import-untyped]

    class_name = cls_node.name.value
    envelopes = []
    try:
        body_stmts = cls_node.body.body
    except AttributeError:
        return envelopes
    for stmt in body_stmts:
        # Unwrap SimpleStatementLine (rare in class bodies but legal for pass, etc.)
        if isinstance(stmt, libcst.SimpleStatementLine):
            continue
        if isinstance(stmt, libcst.FunctionDef):
            kind = _method_kind(stmt)
            env = _function_envelope(stmt, module=module, method_kind=kind)
            # Rewrite name to dotted form: "ClassName.methodName"
            env["name"] = f"{class_name}.{stmt.name.value}"
            envelopes.append(env)
    return envelopes


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

    # WI-890: collect module-level functions first, then one level of class methods.
    # Module-level functions have no "methodKind" field (byte-equivalence with pre-WI-890).
    # Class methods have "methodKind": "static"|"class"|"instance" and dotted names.
    functions = [
        _function_envelope(s, module) for s in module.body if isinstance(s, libcst.FunctionDef)
    ]
    for s in module.body:
        if isinstance(s, libcst.ClassDef):
            functions.extend(_class_method_envelopes(s, module))
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
