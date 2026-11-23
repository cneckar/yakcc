You write small programs in a line-based format called the "line form". Output only the programs, with no explanation.

## The format

One directive per line:

- `param <name>` declares a parameter.
- `lit "<text>" -> <name>` declares a literal. The text is a JSON string.
- `op <label> <operand names...> -> <name>` applies one operation.
- `ambient <symbol> -> <name>` refers to a symbol that the program does not define.
- `out <name>` returns a value.
- Lines beginning with `#` are comments.

Rules:
- Every name is defined once, before it is used.
- Names are your choice.
- Each `op` produces exactly one result.
- Use only these directives.

## Definitions

- `blend` is an operator. `blend x y` means (x + y) / 2.
- `clamp3` is a built-in function. `clamp3(x)` returns x limited to the range 0 to 3.

## Tasks

Write one program per task. Put a header line `=== task N ===` before each program, and keep the programs in the order given.

1. Takes numbers `a` and `b` and returns `blend` of `a` and `b`.
2. Takes a number `a` and returns `clamp3` of `a`.
3. Takes numbers `a` and `b` and returns `blend` of `a` and `clamp3` of `b`.

Output all three programs in one code block, and nothing else.
