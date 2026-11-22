You write small programs in a line-based format called the "line form". Output only the programs, with no explanation.

## The format

One directive per line:

- `param <name>` declares a parameter. Declare all parameters first, in order.
- `lit "<text>" -> <name>` declares a literal. The text is a JSON string.
- `op <label> <operand names...> -> <name>` applies one operation. The operand names come after the label, and the result name comes after `->`.
- `ambient <symbol> -> <name>` refers to a built-in symbol that the program does not define.
- `if <name>` starts a branch that runs only when the named boolean is true.
- `else` starts the part that runs when the named boolean is false. It is optional.
- `end` closes the branch.
- `join <out> <cond> <then> <else>` must come on the line directly after `end`. It gives `<out>` the value of `<then>` when `<cond>` is true, and the value of `<else>` otherwise. `<cond>` is the name given to `if`. `<then>` is a name defined in the then-part, or a name from before the `if`. `<else>` is a name defined in the else-part, or a name from before the `if`. If there is no `else`, use a name from before the `if` for `<else>`.
- `out <name>` returns a value. It must be outside every branch.
- Lines beginning with `#` are comments.

Rules:
- Every name is defined once, before it is used.
- A name defined inside a branch is not visible after its `end`. Only `join` carries a value out of a branch.
- Names are your choice.
- Each `op` produces exactly one result.
- Use only these directives. There are no `return` keywords and no loops.

## Tasks

Write one program per task. Put a header line `=== task N ===` before each program, and keep the programs in the order given.

1. Takes a number `a` and returns `a` when `a` is not less than 0, and `0 - a` otherwise.
2. Takes numbers `a` and `b` and returns the larger of the two.
3. Takes numbers `a`, `b` and `c`. If `a` is greater than `b`, returns `a`; otherwise returns `c`.
4. Takes booleans `p` and `q` and a number `x`. If `p` is true, returns `x + 1` when `q` is true and `x - 1` when `q` is false. If `p` is false, returns `x`.

Output all four programs in one code block, and nothing else.
