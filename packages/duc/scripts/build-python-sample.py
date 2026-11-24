# SPDX-License-Identifier: Apache-2.0
"""Builds the fixed Python sample for raising from Python (#1298).

Pure functions from CPython's standard library (Python Software Foundation License; the source of
each is copied verbatim, with its module and the CPython version it was taken from), each with the
types of inputs the differential test generates. Run with the CPython the sample should pin:
    python3 packages/duc/scripts/build-python-sample.py
It rewrites src/__fixtures__/python-sample.json. The sample is fixed: rerun only to change it.
"""
import importlib, inspect, json, os, sys, textwrap

UNIT = {"float": [0.0, 1.0]}
SIGNED = {"float": [-1.0, 1.0]}
YEAR = {"int": [1, 9999]}
SMALL = {"int": [-3, 12]}
URLISH = {"str": "ab:/?#@=<>URL ", "max": 12}

SAMPLE = [
    ("colorsys", "rgb_to_yiq", [UNIT, UNIT, UNIT]),
    ("colorsys", "yiq_to_rgb", [UNIT, SIGNED, SIGNED]),
    ("colorsys", "rgb_to_hls", [UNIT, UNIT, UNIT]),
    ("colorsys", "hls_to_rgb", [UNIT, UNIT, UNIT]),
    ("colorsys", "_v", [UNIT, UNIT, SIGNED]),
    ("colorsys", "rgb_to_hsv", [UNIT, UNIT, UNIT]),
    ("colorsys", "hsv_to_rgb", [UNIT, UNIT, UNIT]),
    ("calendar", "isleap", ["int"]),
    ("calendar", "leapdays", [YEAR, YEAR]),
    ("string", "capwords", [{"str": "aB c\t-d", "max": 10}, {"opt": {"lit": [None, " ", "-"]}}]),
    ("html", "escape", [{"str": "a&<>\"' ", "max": 8}, {"opt": "bool"}]),
    ("difflib", "_format_range_unified", [SMALL, SMALL]),
    ("difflib", "_format_range_context", [SMALL, SMALL]),
    ("ipaddress", "_count_righthand_zero_bits", [{"int": [0, 4096]}, {"int": [0, 32]}]),
    ("urllib.parse", "_splitnetloc", [URLISH, {"opt": {"int": [0, 6]}}]),
    ("urllib.parse", "unwrap", [{"union": [URLISH, {"lit": ["<URL:http://a/b>", " <x> ", "URL:y", "<>"]}]}]),
    ("urllib.parse", "_splitport", [{"str": "ab:12", "max": 8}]),
    ("urllib.parse", "_splituser", [URLISH]),
    ("urllib.parse", "_splitpasswd", [URLISH]),
    ("urllib.parse", "_splitvalue", [URLISH]),
    ("urllib.parse", "_splittag", [URLISH]),
    ("urllib.parse", "_splitquery", [URLISH]),
    ("email.utils", "quote", [{"str": "a\\\"b", "max": 8}]),
    ("email.utils", "unquote", [{"union": [{"str": "a\\\"<>", "max": 8}, {"lit": ["\"a\\\\b\"", "<x>", "\"\"", "\"a\\\"b\""]}]}]),
    ("_pydatetime", "_is_leap", ["int"]),
    ("_pydatetime", "_days_before_year", ["int"]),
    ("_pydatetime", "_days_in_month", [YEAR, {"int": [0, 13]}]),
    ("_pydatetime", "_days_before_month", [YEAR, {"int": [0, 13]}]),
    ("_pydatetime", "_ymd2ord", [YEAR, {"int": [1, 12]}, {"int": [1, 31]}]),
    ("_pydatetime", "_divide_and_round", ["int", {"union": ["int", {"lit": [0, 2, -2]}]}]),
    ("_pydatetime", "_cmp", [{"union": ["int", "float"]}, {"union": ["int", "float"]}]),
    ("heapq", "_siftdown", [{"list": "int", "min": 5, "max": 5}, {"int": [0, 2]}, {"int": [0, 4]}]),
    ("heapq", "_siftup", [{"list": "int", "min": 5, "max": 5}, {"int": [0, 4]}]),
    ("shlex", "quote", [{"str": "a b'$", "max": 6}]),
    ("glob", "_ishidden", [{"str": ".ab", "max": 4}]),
    ("locale", "_strip_padding", [{"str": "  ab ", "max": 8}, {"int": [0, 4]}]),
    ("_strptime", "_calc_julian_from_U_or_W", [YEAR, {"int": [0, 53]}, {"int": [0, 6]}, "bool"]),
    ("textwrap", "dedent", [{"str": "  a\n\tb\n c", "max": 12}]),
]

import ast


def context(mod, source):
    """The module's top-level statements that define or change the names `source` reads, found
    transitively, in module order: what a raiser needs to resolve a module-level name."""
    tree = ast.parse(inspect.getsource(mod))
    defines = {}
    for i, st in enumerate(tree.body):
        names = set()
        if isinstance(st, (ast.FunctionDef, ast.ClassDef)):
            names.add(st.name)
        elif isinstance(st, (ast.Import, ast.ImportFrom)):
            names.update((a.asname or a.name).split(".")[0] for a in st.names)
        else:
            names.update(n.id for n in ast.walk(st) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store))
            # A module-level call on a name (_DAYS_BEFORE_MONTH.append(...)) changes it.
            names.update(n.value.id for n in ast.walk(st) if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and isinstance(n.ctx, ast.Load) and not isinstance(st, ast.Assign))
        for n in names:
            defines.setdefault(n, []).append(i)
    wanted, todo = set(), [ast.parse(source)]
    while todo:
        t = todo.pop()
        for n in ast.walk(t):
            if isinstance(n, ast.Name) and n.id in defines and n.id not in wanted:
                wanted.add(n.id)
                for i in defines[n.id]:
                    todo.append(tree.body[i])
    picked = sorted({i for n in wanted for i in defines[n]})
    return "\n".join(ast.get_source_segment(inspect.getsource(mod), tree.body[i]) for i in picked)


out = []
for module, name, args in SAMPLE:
    mod = importlib.import_module(module)
    fn = getattr(mod, name)
    source = textwrap.dedent(inspect.getsource(fn))
    out.append({
        "module": module,
        "name": name,
        "args": args,
        "source": source,
        "context": context(mod, source),
    })
here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "..", "src", "__fixtures__", "python-sample.json")
with open(path, "w") as f:
    json.dump({"python": sys.version.split()[0], "license": "PSF-2.0 (CPython standard library)", "functions": out}, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(len(out), "functions from CPython", sys.version.split()[0])
