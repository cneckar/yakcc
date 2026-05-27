# SPDX-License-Identifier: MIT
#
# libcst-parse.py — emit a JSON-AST envelope for the Python source on stdin.
# WI-782 slice 1: minimal wire contract — enough for the TypeScript caller
# to detect that Python + libcst are present and that the parse succeeded.
# Slice 2 expands the JSON shape to carry the full AST detail the mapping
# pass needs.
#
# Wire shape (slice 1):
#   {"version": 1, "module": {"type": "Module", "stmt_count": <int>}}
#
# Exit codes:
#   0 — success; JSON envelope on stdout
#   1 — libcst missing or import failure (stderr explains)
#   2 — parse failure (stderr carries the libcst exception text)

import json
import sys


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
    except Exception as exc:  # noqa: BLE001 — defensive: libcst may raise other types
        print(f"libcst unexpected error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    # Slice 1: emit a minimal envelope. Slice 2 will walk the tree and produce
    # full per-node detail. Today we only emit the count so tests have a
    # numeric invariant to check against the input source.
    envelope = {
        "version": 1,
        "module": {
            "type": type(module).__name__,
            "stmt_count": len(module.body),
        },
    }
    json.dump(envelope, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
