// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/tasks-hard/avl-tree/reference-impl.ts
//
// AVL tree reference implementation — self-balancing BST with
// insert / get / delete / keysInOrder / height / size.
//
// @decision DEC-BENCH-B4-V5-HARD-TASKS-001
// title: AVL tree reference — delete rebalancing is the adversarial trap
// status: accepted
// rationale: Weak models (Haiku) get single-rotation cases right but
//   systematically fail the double-rotation cases triggered during deletion
//   (LR and RL), and fail to propagate rebalancing upward through the
//   ancestor chain after a deletion. This is the canonical Haiku failure
//   mode for tree-shaped data structures: they reduce to a single rotation
//   and skip the height-update + ancestor walk. The oracle tests verify the
//   AVL balance invariant (|bf| ≤ 1) at every node after a non-trivial
//   delete sequence, which immediately exposes this class of bug.

/** A single node in the AVL tree. */
class AVLNode<K, V> {
  key: K;
  value: V;
  left: AVLNode<K, V> | null = null;
  right: AVLNode<K, V> | null = null;
  height: number = 1;

  constructor(key: K, value: V) {
    this.key = key;
    this.value = value;
  }
}

/**
 * Self-balancing AVL binary search tree.
 *
 * K must be comparable with < and >.
 * All operations are O(log n).
 */
export class AVLTree<K, V> {
  private root: AVLNode<K, V> | null = null;
  private _size: number = 0;

  // ── size / height ──────────────────────────────────────────────────────

  /** Number of key-value pairs currently in the tree. */
  size(): number {
    return this._size;
  }

  /** Height of the tree (0 for an empty tree, 1 for a single node). */
  height(): number {
    return this.nodeHeight(this.root);
  }

  // ── public API ─────────────────────────────────────────────────────────

  /**
   * Insert or overwrite a key-value pair.
   * If the key already exists the value is replaced; size does not change.
   */
  insert(key: K, value: V): void {
    let inserted = false;
    this.root = this.insertNode(this.root, key, value, (flag: boolean) => {
      inserted = flag;
    });
    if (inserted) this._size++;
  }

  /**
   * Return the value associated with key, or undefined if absent.
   */
  get(key: K): V | undefined {
    let node = this.root;
    while (node !== null) {
      if (key < node.key) {
        node = node.left;
      } else if (key > node.key) {
        node = node.right;
      } else {
        return node.value;
      }
    }
    return undefined;
  }

  /**
   * Delete the key from the tree.
   * No-op if the key is not present.
   */
  delete(key: K): void {
    let deleted = false;
    this.root = this.deleteNode(this.root, key, (flag: boolean) => {
      deleted = flag;
    });
    if (deleted) this._size--;
  }

  /**
   * Return all keys in ascending (in-order) sort order.
   */
  keysInOrder(): K[] {
    const result: K[] = [];
    this.inOrder(this.root, result);
    return result;
  }

  // ── private helpers ────────────────────────────────────────────────────

  private nodeHeight(node: AVLNode<K, V> | null): number {
    return node === null ? 0 : node.height;
  }

  private updateHeight(node: AVLNode<K, V>): void {
    node.height =
      1 + Math.max(this.nodeHeight(node.left), this.nodeHeight(node.right));
  }

  private balanceFactor(node: AVLNode<K, V>): number {
    return this.nodeHeight(node.left) - this.nodeHeight(node.right);
  }

  // ── rotations ──────────────────────────────────────────────────────────

  /**
   * Right rotation around y.
   *
   *       y                x
   *      / \              / \
   *     x   C    →      A   y
   *    / \                  / \
   *   A   B                B   C
   */
  private rotateRight(y: AVLNode<K, V>): AVLNode<K, V> {
    const x = y.left!;
    const B = x.right;
    x.right = y;
    y.left = B;
    this.updateHeight(y);
    this.updateHeight(x);
    return x;
  }

  /**
   * Left rotation around x.
   *
   *     x                  y
   *    / \                / \
   *   A   y    →        x   C
   *      / \           / \
   *     B   C         A   B
   */
  private rotateLeft(x: AVLNode<K, V>): AVLNode<K, V> {
    const y = x.right!;
    const B = y.left;
    y.left = x;
    x.right = B;
    this.updateHeight(x);
    this.updateHeight(y);
    return y;
  }

  /** Re-balance node after an insert or delete and return the new root of the subtree. */
  private rebalance(node: AVLNode<K, V>): AVLNode<K, V> {
    this.updateHeight(node);
    const bf = this.balanceFactor(node);

    // Left-heavy
    if (bf > 1) {
      const left = node.left!;
      if (this.balanceFactor(left) < 0) {
        // LR case: left child is right-heavy → double rotation
        node.left = this.rotateLeft(left);
      }
      // LL case (or after LR fix)
      return this.rotateRight(node);
    }

    // Right-heavy
    if (bf < -1) {
      const right = node.right!;
      if (this.balanceFactor(right) > 0) {
        // RL case: right child is left-heavy → double rotation
        node.right = this.rotateRight(right);
      }
      // RR case (or after RL fix)
      return this.rotateLeft(node);
    }

    return node;
  }

  private insertNode(
    node: AVLNode<K, V> | null,
    key: K,
    value: V,
    setInserted: (flag: boolean) => void,
  ): AVLNode<K, V> {
    if (node === null) {
      setInserted(true);
      return new AVLNode(key, value);
    }
    if (key < node.key) {
      node.left = this.insertNode(node.left, key, value, setInserted);
    } else if (key > node.key) {
      node.right = this.insertNode(node.right, key, value, setInserted);
    } else {
      // Key exists — overwrite value, no structural change needed.
      node.value = value;
      setInserted(false);
      return node; // no rebalance needed
    }
    return this.rebalance(node);
  }

  /** Find the minimum-key node in a subtree. */
  private minNode(node: AVLNode<K, V>): AVLNode<K, V> {
    while (node.left !== null) node = node.left;
    return node;
  }

  private deleteNode(
    node: AVLNode<K, V> | null,
    key: K,
    setDeleted: (flag: boolean) => void,
  ): AVLNode<K, V> | null {
    if (node === null) {
      // Key not found — no-op.
      return null;
    }

    if (key < node.key) {
      node.left = this.deleteNode(node.left, key, setDeleted);
    } else if (key > node.key) {
      node.right = this.deleteNode(node.right, key, setDeleted);
    } else {
      // Found the node to delete.
      setDeleted(true);

      if (node.left === null) {
        // Zero or one child (right or null)
        return node.right;
      }
      if (node.right === null) {
        // One child (left)
        return node.left;
      }

      // Two children: replace with in-order successor (min of right subtree),
      // then delete the successor from the right subtree.
      const successor = this.minNode(node.right);
      node.key = successor.key;
      node.value = successor.value;
      // Delete the successor (it has at most one right child).
      // We use a dummy setDeleted because we already know it will fire.
      node.right = this.deleteNode(node.right, successor.key, () => {});
    }

    return this.rebalance(node);
  }

  private inOrder(node: AVLNode<K, V> | null, result: K[]): void {
    if (node === null) return;
    this.inOrder(node.left, result);
    result.push(node.key);
    this.inOrder(node.right, result);
  }

  // ── balance invariant checker (exposed for oracle tests) ───────────────

  /**
   * Verify the AVL balance invariant across the entire tree.
   * Returns true iff every node has |balanceFactor| ≤ 1.
   * Exposed for oracle tests — not needed by callers.
   */
  isBalanced(): boolean {
    return this.checkBalanced(this.root);
  }

  private checkBalanced(node: AVLNode<K, V> | null): boolean {
    if (node === null) return true;
    const bf = this.balanceFactor(node);
    if (Math.abs(bf) > 1) return false;
    return this.checkBalanced(node.left) && this.checkBalanced(node.right);
  }
}
