// SPDX-License-Identifier: MIT
// Reference implementation for B4-v3 oracle validation.

export class TwoPhaseCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwoPhaseCommitError';
  }
}

type ParticipantState = 'idle' | 'prepared' | 'committed' | 'aborted';
type CoordinatorState = 'idle' | 'running' | 'committed' | 'aborted';

export class Participant {
  private state: ParticipantState = 'idle';
  private readonly id: string;
  private readonly vote: 'yes' | 'no';

  constructor(id: string, vote: 'yes' | 'no') {
    this.id = id;
    this.vote = vote;
  }

  getId(): string { return this.id; }

  prepare(): 'yes' | 'no' {
    if (this.vote === 'yes') {
      this.state = 'prepared';
    } else {
      this.state = 'aborted';
    }
    return this.vote;
  }

  commit(): void {
    if (this.state === 'prepared') {
      this.state = 'committed';
    }
    // idempotent: no-op from any other state
  }

  abort(): void {
    if (this.state === 'idle' || this.state === 'prepared') {
      this.state = 'aborted';
    }
    // idempotent: no-op from 'committed' or 'aborted'
  }

  getState(): ParticipantState { return this.state; }
}

export class Coordinator {
  private state: CoordinatorState = 'idle';
  private readonly participants: Participant[];

  constructor(participants: Participant[]) {
    this.participants = [...participants];
  }

  run(): 'committed' | 'aborted' {
    if (this.participants.length === 0) {
      throw new TwoPhaseCommitError('Cannot run with empty participants list');
    }
    if (this.state !== 'idle') {
      throw new TwoPhaseCommitError(`Cannot run in state '${this.state}'`);
    }
    this.state = 'running';

    const votes = this.participants.map(p => p.prepare());
    const allYes = votes.every(v => v === 'yes');

    if (allYes) {
      for (const p of this.participants) p.commit();
      this.state = 'committed';
      return 'committed';
    } else {
      for (const p of this.participants) p.abort();
      this.state = 'aborted';
      return 'aborted';
    }
  }

  getState(): CoordinatorState { return this.state; }
}
