You write small programs in a line-based format called the "line form". Output only the programs, with no explanation.

## The format

One directive per line:

- `param <name>` declares a parameter. Declare all parameters first, in order.
- `lit "<text>" -> <name>` declares a literal. The text is a JSON string.
- `op <label> <operand names...> -> <name>` applies one operation. The operand names come after the label, and the result name comes after `->`.
- `ambient <symbol> -> <name>` refers to a built-in symbol that the program does not define.
- `out <name>` returns a value.
- Lines beginning with `#` are comments.

Rules:
- Every name is defined once, before it is used.
- Names are your choice.
- Each `op` produces exactly one result.
- Use only these directives. There are no conditionals, loops or `return` keywords.

## Tasks

Write one program per task. Put a header line `=== task N ===` before each program, and keep the programs in the order given.

1. Takes numbers `a` and `b` and returns `a` plus `b`, times `a` minus `b`.
2. Takes a number `a` and returns `a` times `a`, plus 2 times `a`, plus 1.
3. Takes numbers `a`, `b` and `c` and returns `a` minus `b`, minus `c`.
4. Takes numbers `a`, `b` and `c` and returns `true` if `a` is less than `b` and `b` is less than `c`, otherwise `false`.
5. Takes an array `xs` of numbers and returns its first element times its second element, plus its third element.
6. Takes two strings `s` and `t` and returns `s` encoded with `encodeURI`, followed by `t` encoded with `encodeURI`.

Output all six programs in one code block, and nothing else.
