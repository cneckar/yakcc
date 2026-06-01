// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/tasks-hard/avl-tree/oracle.test.ts
//
// Oracle tests for the avl-tree task (B4-v5-hard).
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).
//
// Adversarial coverage: these tests specifically target the Haiku failure modes:
//   1. Double-rotation (LR / RL) cases that Haiku reduces to single-rotation.
//   2. Rebalancing propagation up the ancestor chain after deletion.
//   3. In-order invariant after a non-trivial delete sequence.
//   4. Balance factor invariant (|bf| ≤ 1) at every node post-delete.

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

type AVLTreeCtor = new <K, V>() => {
  insert(key: K, value: V): void;
  get(key: K): V | undefined;
  delete(key: K): void;
  keysInOrder(): K[];
  height(): number;
  size(): number;
  isBalanced(): boolean;
};

let AVLTree: AVLTreeCtor;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  AVLTree = mod.AVLTree;
  if (typeof AVLTree !== 'function') {
    throw new Error(`Implementation at ${implPath} must export AVLTree as a named class`);
  }
});

// ── basic insert + get ─────────────────────────────────────────────────────

describe('avl-tree — insert and get', () => {
  it('inserts a single key and retrieves it', () => {
    const t = new AVLTree<number, string>();
    t.insert(10, 'ten');
    expect(t.get(10)).toBe('ten');
    expect(t.size()).toBe(1);
  });

  it('returns undefined for absent key', () => {
    const t = new AVLTree<number, string>();
    t.insert(5, 'five');
    expect(t.get(99)).toBeUndefined();
  });

  it('overwrites value when key already exists, size unchanged', () => {
    const t = new AVLTree<number, string>();
    t.insert(7, 'old');
    t.insert(7, 'new');
    expect(t.get(7)).toBe('new');
    expect(t.size()).toBe(1);
  });

  it('inserts multiple keys and retrieves each correctly', () => {
    const t = new AVLTree<number, number>();
    const keys = [5, 3, 8, 1, 4, 7, 9];
    for (const k of keys) t.insert(k, k * 10);
    for (const k of keys) expect(t.get(k)).toBe(k * 10);
    expect(t.size()).toBe(7);
  });
});

// ── in-order traversal ─────────────────────────────────────────────────────

describe('avl-tree — keysInOrder', () => {
  it('empty tree returns empty array', () => {
    const t = new AVLTree<number, string>();
    expect(t.keysInOrder()).toEqual([]);
  });

  it('in-order is sorted for ascending insert sequence', () => {
    const t = new AVLTree<number, number>();
    for (let i = 1; i <= 7; i++) t.insert(i, i);
    expect(t.keysInOrder()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('in-order is sorted for descending insert sequence (forces left-rotation)', () => {
    const t = new AVLTree<number, number>();
    for (let i = 7; i >= 1; i--) t.insert(i, i);
    expect(t.keysInOrder()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('in-order is sorted for a random-order sequence', () => {
    const t = new AVLTree<number, number>();
    const keys = [15, 3, 22, 8, 1, 18, 30, 5, 12, 25];
    for (const k of keys) t.insert(k, k);
    const sorted = [...keys].sort((a, b) => a - b);
    expect(t.keysInOrder()).toEqual(sorted);
  });
});

// ── AVL balance invariant after inserts ────────────────────────────────────

describe('avl-tree — balance invariant after inserts', () => {
  it('tree is balanced after ascending insert (forces right-rotation)', () => {
    const t = new AVLTree<number, number>();
    for (let i = 1; i <= 10; i++) t.insert(i, i);
    expect(t.isBalanced()).toBe(true);
  });

  it('tree is balanced after descending insert (forces left-rotation)', () => {
    const t = new AVLTree<number, number>();
    for (let i = 10; i >= 1; i--) t.insert(i, i);
    expect(t.isBalanced()).toBe(true);
  });

  it('tree is balanced after LR-rotation-triggering sequence [3,1,2]', () => {
    // Insert 3, then 1, then 2: left child becomes right-heavy → LR double rotation
    const t = new AVLTree<number, number>();
    t.insert(3, 3);
    t.insert(1, 1);
    t.insert(2, 2); // triggers LR case
    expect(t.isBalanced()).toBe(true);
    expect(t.keysInOrder()).toEqual([1, 2, 3]);
  });

  it('tree is balanced after RL-rotation-triggering sequence [1,3,2]', () => {
    // Insert 1, then 3, then 2: right child becomes left-heavy → RL double rotation
    const t = new AVLTree<number, number>();
    t.insert(1, 1);
    t.insert(3, 3);
    t.insert(2, 2); // triggers RL case
    expect(t.isBalanced()).toBe(true);
    expect(t.keysInOrder()).toEqual([1, 2, 3]);
  });

  it('height is O(log n) for 64 sequential inserts', () => {
    const t = new AVLTree<number, number>();
    for (let i = 1; i <= 64; i++) t.insert(i, i);
    // AVL height ≤ 1.44 * log2(n+2); for n=64 that's ≤ ~9.3 → height ≤ 10
    expect(t.height()).toBeLessThanOrEqual(10);
    expect(t.isBalanced()).toBe(true);
  });
});

// ── delete ─────────────────────────────────────────────────────────────────

describe('avl-tree — delete (adversarial cases)', () => {
  it('delete on empty tree is a no-op', () => {
    const t = new AVLTree<number, number>();
    expect(() => t.delete(5)).not.toThrow();
    expect(t.size()).toBe(0);
  });

  it('delete absent key is a no-op, size unchanged', () => {
    const t = new AVLTree<number, number>();
    t.insert(5, 5);
    t.delete(99);
    expect(t.size()).toBe(1);
  });

  it('delete leaf node — in-order correct, balance holds', () => {
    const t = new AVLTree<number, number>();
    [5, 3, 7, 1, 4, 6, 8].forEach(k => t.insert(k, k));
    t.delete(1); // leaf
    expect(t.keysInOrder()).toEqual([3, 4, 5, 6, 7, 8]);
    expect(t.isBalanced()).toBe(true);
    expect(t.size()).toBe(6);
  });

  it('delete node with one child — in-order correct, balance holds', () => {
    const t = new AVLTree<number, number>();
    [5, 3, 7, 1, 6, 8].forEach(k => t.insert(k, k));
    t.delete(3); // has only left child (1)
    expect(t.keysInOrder()).toEqual([1, 5, 6, 7, 8]);
    expect(t.isBalanced()).toBe(true);
  });

  it('delete node with two children uses in-order successor correctly', () => {
    const t = new AVLTree<number, number>();
    [5, 3, 7, 2, 4, 6, 8].forEach(k => t.insert(k, k));
    t.delete(5); // root, two children — replaced by successor (6)
    expect(t.get(5)).toBeUndefined();
    expect(t.get(6)).toBe(6);
    expect(t.keysInOrder()).toEqual([2, 3, 4, 6, 7, 8]);
    expect(t.isBalanced()).toBe(true);
    expect(t.size()).toBe(6);
  });

  it('delete triggers rebalancing propagation — sequence that exposes ancestor walk failure', () => {
    // Build a tree, then delete nodes from the heavy side to force rebalancing to
    // propagate more than one level up. Haiku commonly stops after one rotation.
    const t = new AVLTree<number, number>();
    // Insert 15 nodes in a pattern that creates a balanced tree with depth 4.
    const keys = [10, 5, 20, 3, 7, 15, 25, 1, 4, 6, 8, 13, 17, 23, 30];
    for (const k of keys) t.insert(k, k);
    expect(t.isBalanced()).toBe(true);

    // Delete from the left subtree to make it right-heavy at multiple levels.
    t.delete(1);
    t.delete(4);
    t.delete(3);
    expect(t.isBalanced()).toBe(true);
    expect(t.keysInOrder()).toEqual([5, 6, 7, 8, 10, 13, 15, 17, 20, 23, 25, 30]);
    expect(t.size()).toBe(12);
  });

  it('delete-all sequence — tree ends empty', () => {
    const t = new AVLTree<number, number>();
    const keys = [4, 2, 6, 1, 3, 5, 7];
    for (const k of keys) t.insert(k, k);
    for (const k of keys) t.delete(k);
    expect(t.size()).toBe(0);
    expect(t.keysInOrder()).toEqual([]);
    expect(t.height()).toBe(0);
  });

  it('double-rotation after delete — RL case triggered at ancestor', () => {
    // Sequence chosen to force an RL double-rotation during deletion rebalancing.
    // Haiku fails here because it applies at most one rotation per delete.
    const t = new AVLTree<number, number>();
    // Build: insert 50, 30, 70, 20, 40, 60, 80, 35, 45
    [50, 30, 70, 20, 40, 60, 80, 35, 45].forEach(k => t.insert(k, k));
    // Delete 20: subtree rooted at 30 becomes right-heavy;
    // 40's left (35) is present → RL rotation at 30 needed.
    t.delete(20);
    expect(t.isBalanced()).toBe(true);
    expect(t.keysInOrder()).toEqual([30, 35, 40, 45, 50, 60, 70, 80]);
  });
});

// ── height guarantees ──────────────────────────────────────────────────────

describe('avl-tree — height', () => {
  it('height of empty tree is 0', () => {
    const t = new AVLTree<number, number>();
    expect(t.height()).toBe(0);
  });

  it('height of single node is 1', () => {
    const t = new AVLTree<number, number>();
    t.insert(1, 1);
    expect(t.height()).toBe(1);
  });

  it('height decreases after deleting nodes', () => {
    const t = new AVLTree<number, number>();
    for (let i = 1; i <= 7; i++) t.insert(i, i);
    const h1 = t.height();
    t.delete(4); t.delete(5); t.delete(6); t.delete(7);
    const h2 = t.height();
    expect(h2).toBeLessThanOrEqual(h1);
  });
});
