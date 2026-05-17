// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/tasks/two-phase-commit/oracle.test.ts
//
// Oracle tests for the two-phase-commit task (B4-v3).
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

let Participant: new (id: string, vote: 'yes' | 'no') => {
  getId(): string;
  prepare(): 'yes' | 'no';
  commit(): void;
  abort(): void;
  getState(): string;
};
let Coordinator: new (ps: typeof Participant extends new (...a: any) => infer T ? T[] : never) => {
  run(): 'committed' | 'aborted';
  getState(): string;
};
let TwoPhaseCommitError: any;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  Participant = mod.Participant;
  Coordinator = mod.Coordinator;
  TwoPhaseCommitError = mod.TwoPhaseCommitError;
  if (!Participant || !Coordinator) {
    throw new Error(`Implementation at ${implPath} must export: Participant, Coordinator`);
  }
});

describe('two-phase-commit — all YES', () => {
  it('returns committed when all participants vote yes', () => {
    const ps = [new Participant('p1', 'yes'), new Participant('p2', 'yes')];
    const c = new Coordinator(ps);
    expect(c.run()).toBe('committed');
  });

  it('coordinator state is committed after unanimous yes', () => {
    const ps = [new Participant('p1', 'yes')];
    const c = new Coordinator(ps);
    c.run();
    expect(c.getState()).toBe('committed');
  });

  it('all participants are in committed state after all-yes run', () => {
    const ps = [new Participant('p1', 'yes'), new Participant('p2', 'yes'), new Participant('p3', 'yes')];
    const c = new Coordinator(ps);
    c.run();
    for (const p of ps) expect(p.getState()).toBe('committed');
  });
});

describe('two-phase-commit — any NO', () => {
  it('returns aborted when one participant votes no', () => {
    const ps = [new Participant('p1', 'yes'), new Participant('p2', 'no')];
    const c = new Coordinator(ps);
    expect(c.run()).toBe('aborted');
  });

  it('coordinator state is aborted after any-no run', () => {
    const ps = [new Participant('p1', 'no')];
    const c = new Coordinator(ps);
    c.run();
    expect(c.getState()).toBe('aborted');
  });

  it('ALL participants are aborted even if some voted yes', () => {
    const ps = [
      new Participant('p1', 'yes'),
      new Participant('p2', 'no'),
      new Participant('p3', 'yes'),
    ];
    const c = new Coordinator(ps);
    c.run();
    for (const p of ps) expect(p.getState()).toBe('aborted');
  });

  it('all-no case also aborts all participants', () => {
    const ps = [new Participant('p1', 'no'), new Participant('p2', 'no')];
    const c = new Coordinator(ps);
    c.run();
    for (const p of ps) expect(p.getState()).toBe('aborted');
  });
});

describe('two-phase-commit — coordinator error cases', () => {
  it('throws when participants list is empty', () => {
    const c = new Coordinator([]);
    expect(() => c.run()).toThrow();
  });

  it('throws when run() is called twice', () => {
    const ps = [new Participant('p1', 'yes')];
    const c = new Coordinator(ps);
    c.run();
    expect(() => c.run()).toThrow();
  });

  it('throws when run() called after aborted', () => {
    const ps = [new Participant('p1', 'no')];
    const c = new Coordinator(ps);
    c.run();
    expect(() => c.run()).toThrow();
  });
});

describe('two-phase-commit — participant state machine', () => {
  it('starts in idle state', () => {
    const p = new Participant('p', 'yes');
    expect(p.getState()).toBe('idle');
  });

  it('yes-voter moves to prepared after prepare()', () => {
    const p = new Participant('p', 'yes');
    const vote = p.prepare();
    expect(vote).toBe('yes');
    expect(p.getState()).toBe('prepared');
  });

  it('no-voter moves to aborted after prepare()', () => {
    const p = new Participant('p', 'no');
    const vote = p.prepare();
    expect(vote).toBe('no');
    expect(p.getState()).toBe('aborted');
  });

  it('commit() is idempotent — double-commit does not throw', () => {
    const p = new Participant('p', 'yes');
    p.prepare();
    p.commit();
    expect(() => p.commit()).not.toThrow();
    expect(p.getState()).toBe('committed');
  });

  it('abort() from idle state is safe', () => {
    const p = new Participant('p', 'yes');
    expect(() => p.abort()).not.toThrow();
    expect(p.getState()).toBe('aborted');
  });

  it('abort() from prepared state transitions to aborted', () => {
    const p = new Participant('p', 'yes');
    p.prepare();
    p.abort();
    expect(p.getState()).toBe('aborted');
  });

  it('abort() is idempotent — double-abort does not throw', () => {
    const p = new Participant('p', 'yes');
    p.prepare();
    p.abort();
    expect(() => p.abort()).not.toThrow();
    expect(p.getState()).toBe('aborted');
  });

  it('getId() returns the id passed to constructor', () => {
    const p = new Participant('my-node', 'yes');
    expect(p.getId()).toBe('my-node');
  });
});
