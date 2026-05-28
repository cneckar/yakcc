# SPDX-License-Identifier: MIT
#
# libcst-parse.py — emit a JSON-AST envelope for the Python source on stdin.
# WI-782 slice 2: expanded envelope to carry per-function signature detail
# (name, parameters with annotations, return annotation, body source range).
# Slice 1's stmt_count remains for backward-compat.  Slice 2b expands body
# detail; slice 3 adds purity inference (separate pyright pass).
#
# Wire shape (slice 2):
#   {
#     "version": 1,
#     "module": {
#       "type": "Module",
#       "stmt_count": <int>,
#       "functions": [
#         {
#           "name": "<str>",
#           "params": [
#             {"name": "<str>", "annotation": "<str|null>"}
#           ],
#           "return_annotation": "<str|null>",
#           "body_source": "<str — verbatim Python body text>"
#         }
#       ]
#     }
#   }
#
# Exit codes (unchanged from slice 1):
#   0 — success; JSON envelope on stdout
#   1 — libcst missing or import failure (stderr explains)
#   2 — parse failure (stderr carries the libcst exception text)

import json
import sys


def _annotation_text(node, source_lines):  # type: ignore[no-untyped-def]
    """Extract the text of a libcst Annotation node, or None if absent."""
    if node is None:
        return None
    try:
        # libcst's CodeRange via metadata is the precise way; for slice 2 we
        # use the simpler `.code` property which renders the node back to text.
        return node.code.strip()
    except AttributeError:
        return None


def _function_envelope(fn, module):  # type: ignore[no-untyped-def]
    """Build the per-function dict for the wire envelope."""
    params = []
    for p in fn.params.params:
        params.append(
            {
                "name": p.name.value,
                "annotation": _annotation_text(p.annotation.annotation, None)
                if p.annotation is not None
                else None,
            }
        )
    return_annot = (
        _annotation_text(fn.returns.annotation, None) if fn.returns is not None else None
    )
    # body_source: render the function body as Python text so a downstream
    # raise pass (slice 2b) can parse it. Using libcst's .code preserves
    # exact whitespace; we strip trailing newlines for consistency.
    try:
        body_source = fn.body.code.rstrip("\n")
    except AttributeError:
        body_source = ""
    return {
        "name": fn.name.value,
        "params": params,
        "return_annotation": return_annot,
        "body_source": body_source,
    }


def main() -> int:
    try:
        import libcst  # type: ignore[import-untyped]
    except ImportError as exc:
        print(
            f"libcst is not installed: {exc}. Run: pip install libcst",
            file=sys.stderr,
        )
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

    functions = []
    for stmt in module.body:
        # Top-level function defs only; class methods and nested defs are
        # deferred (per #782 MVP scope: "pure functions only").
        if isinstance(stmt, libcst.FunctionDef):
            functions.append(_function_envelope(stmt, module))

    envelope = {
        "version": 1,
        "module": {
            "type": type(module).__name__,
            "stmt_count": len(module.body),
            "functions": functions,
        },
    }
    json.dump(envelope, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
