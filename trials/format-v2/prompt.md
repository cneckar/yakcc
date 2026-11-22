You write small programs in a line-based format called the "line form". Output only the programs, with no explanation.

## The format

One directive per line. Every value has a name, defined once, before it is used. Names are your choice. Lines beginning with `#` are comments.

**Values**
- `param <name>` declares the next parameter. Declare all parameters first, in order.
- `lit "<literal>" -> <name>` is a literal, written as in JavaScript inside a JSON string: `lit "3" -> three`, `lit "'abc'" -> s`, `lit "true" -> yes`.
- `op <label> <operands...> -> <name>` applies one operation to named values. Operands come after the label, the result after `->`.
- `ambient <symbol> -> <name>` is a built-in global, such as `Math` or `JSON`.
- `out <name>` returns a value.

**Operation labels**
- Operators by their symbol: `+ - * / % < > <= >= === !== && || ??`. A unary operator takes one operand: `op - x -> negated`, `op ! b -> notb`.
- Read a property: `.name`, for example `op .length s -> n`.
- Call a function: `CallExpression`, with the function first and then the arguments: `op CallExpression f a b -> r`. To call a method, read it first: `op .trim s -> m` then `op CallExpression m -> t`.
- Read an element: `op ElementAccess xs i -> x`.
- Array literal: `op ArrayLiteral a b c -> arr`. Spread a value into it: `op ... xs -> sp` then use `sp` as an element.
- Object literal: `op object:["k1","k2"] v1 v2 -> o`. The keys are a JSON list, and the values follow in the same order.
- Template string: `op template:["id-",""] n -> t` builds `` `id-${n}` ``. The JSON list holds the text parts, and the values go between them.
- Set a property: `op .name= o v -> o2`. The result is the updated object.

**Choosing a value: `select`**
- `select <name> <cond> <then> <else>` is `cond ? then : else`. Both values are computed first.

**Branches: `if`**
```
if <cond>
  ...lines run when cond is true...
else
  ...lines run when it is false (optional)...
end
join <name> <cond> <then> <else>
```
A name defined inside a branch is not visible after its `end`. A `join` on the line right after `end` carries a value out: `<then>` is a name from the then-part, or from before the `if`, and `<else>` likewise for the else-part. `<cond>` is the same name as in the `if`.

**Loops**
```
loop <start values...> [with <outside values...>]
carry <names...>
invariant <names...>
  ...body...
while <cond>
next <names...>
end <results...>
```
- Each start value begins one carried variable. `carry` names them inside the body, in the same order.
- Every outside value the body reads must come in through `with`, and `invariant` names them inside the body, in the same order. Write `invariant` with no names when there are none.
- `while <cond>` is computed in the body from the carried values: the loop continues while it is true.
- `next` gives each carried variable's value for the next round, in order.
- `end` names the results: the carried values when the loop stops, in order.

To loop over a collection, write `loop <start values...> of <collection> [with ...]`, then the `carry` and `invariant` lines, then `element <name>` for the current element, then the body. There is no `while`: the loop runs once per element. Then `next` and `end` as above.

**Functions**
```
function <name> [with <outside values...>]
  param <name>      # one per outside value after with, in the same order
  param <name>      # then the function's own parameters
  ...body...
  out <result>
end
```
The function sees outside values only through `with`. Call it with `op CallExpression <name> <args...> -> r`.

## Tasks

Write one program per task. Put a header line `=== task N ===` before each program, and keep the programs in the order given. Use the parameter names given, in the order given.

1. Takes a string `s`. Returns `s` trimmed, then converted to upper case (the methods `trim` and `toUpperCase`).
2. Takes a number `n`. Returns an object with key `name` set to `n`, and key `label` set to the text `id-` followed by `n`.
3. Takes a number `x`. Use an `if`: when `x` is less than 0, the result is `0 - x`. Otherwise it is `x * 2`. Return the result.
4. Takes numbers `a` and `b`. Returns the larger of the two, using `select` (no `if`).
5. Takes a number `n`. Using a `while` loop with a sum starting at 0 and a counter `i` starting at 1, adds up the numbers from 1 to `n`, and returns the sum.
6. Takes an array `xs` and a number `k`. Loops over `xs` and counts the elements greater than `k`. Returns the count.
7. Takes a number `k`. Defines a function `add` that returns its argument plus `k`. Returns `add(1) * add(2)`.
8. Takes numbers `a` and `b`. Returns `Math.max(a, b)` minus `Math.min(a, b)`.
9. Takes a number `x`. Makes an object with key `v` set to 0, then sets its `v` to `x + 1`, and returns the object.
10. Takes an array `xs` and a value `y`. Returns a new array with all the elements of `xs`, followed by `y`.

Output all ten programs in one code block, and nothing else.
