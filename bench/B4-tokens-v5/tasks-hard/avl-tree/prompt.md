Implement a self-balancing AVL tree.

Export a **single generic class**:

```typescript
export class AVLTree<K, V> {
  /** Insert or overwrite a key-value pair. Size increases only on new keys. */
  insert(key: K, value: V): void;
  /** Return the value for key, or undefined if absent. */
  get(key: K): V | undefined;
  /** Remove key from the tree. No-op if absent. */
  delete(key: K): void;
  /** Return all keys in ascending sorted order (in-order traversal). */
  keysInOrder(): K[];
  /** Height of the tree (0 for empty, 1 for single node). */
  height(): number;
  /** Number of key-value pairs in the tree. */
  size(): number;
}
```

**K is comparable with `<` and `>`** (assume numeric or string keys in practice).

Constraints:
- No external libraries.
- The tree must be self-balancing using the AVL algorithm: after every `insert` and `delete`, rebalance the affected path so that every node satisfies `|balanceFactor| ≤ 1`.
- `balanceFactor(node) = height(node.left) − height(node.right)`.
- Four rotation cases: LL (right-rotate), RR (left-rotate), LR (left-rotate child, then right-rotate parent), RL (right-rotate child, then left-rotate parent).
- `delete` of a node with two children must replace it with its **in-order successor** (minimum of the right subtree), then delete that successor from the right subtree.
- After the structural change, rebalance must propagate **all the way up** to the root — not just one level.
- All operations must be O(log n).

**Adversarial trap:** Weak models commonly implement single-rotation cases correctly but
fail the double-rotation (LR and RL) cases, and/or stop rebalancing after the first
rotation instead of continuing up the ancestor chain. A delete that makes a subtree
imbalanced at depth k must rebalance at depth k AND at all ancestors above it.
