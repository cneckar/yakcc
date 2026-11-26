// zod 4, an npm package of yakcc's closure, natively (#1368, #1361 P2): its schemas built by
// $constructor (a class extending Object, Symbol.hasInstance), parsed and refused as Node's.
import { z } from "zod";

const User = z.object({
  name: z.string().min(2),
  age: z.number().int().positive(),
  tags: z.array(z.string()).optional(),
  kind: z.enum(["a", "b"]),
});
const out = [];
out.push(JSON.stringify(User.parse({ name: "Ann", age: 3, kind: "a" })));
const bad = User.safeParse({ name: "A", age: -1.5, kind: "c", extra: 1 });
out.push(
  bad.success,
  JSON.stringify(bad.error.issues.map((i) => [i.code, i.path.join("."), i.message])),
);
const U = z.union([z.string(), z.number()]).transform((v) => String(v).length);
out.push(U.parse(12345), U.safeParse(true).success);
const R = z.record(z.string(), z.boolean()).default({});
out.push(
  JSON.stringify(R.parse(undefined)),
  JSON.stringify(z.tuple([z.string(), z.number()]).parse(["x", 1])),
);
out.push(z.string().email().safeParse("a@b.co").success, z.coerce.number().parse("42"));
out.push(User instanceof z.ZodObject, z.string() instanceof z.ZodObject);
try {
  z.number().parse("nope");
} catch (e) {
  out.push(e instanceof z.ZodError, e.issues[0].code);
}
console.log(out.join("\n"));
