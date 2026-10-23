import type { ChalkWhiteboardView } from "./types";

type Origin = { readonly connectionId: string; readonly lead: bigint };
type Position = Origin & { readonly sequence: number };
type Participant = Position & { readonly applied: Position | undefined };

function compare(left: Position, right: Position): number {
  if (left.connectionId === right.connectionId) return left.sequence - right.sequence;
  if (left.lead !== right.lead) return left.lead > right.lead ? 1 : -1;
  return left.connectionId.localeCompare(right.connectionId);
}

function before(left: Position, right: Position): boolean {
  return compare(left, right) < 0;
}

/** Last real leadership wins across tabs; sequence orders one tab's views.
 * Keep-alives carry the authenticated stamp unchanged. Arrival time, database
 * transactions and local timers never grant leadership. Histories are bounded.
 */
export class ChalkWhiteboardViewVersions {
  readonly #sequences = new Map<string, number>();
  readonly #participants = new Map<string, Participant>();
  readonly #epochs = new Map<string, Position>();
  readonly #tabs = new Map<string, Position>();
  readonly #appliedTabs = new Map<string, number>();

  #epoch(view: ChalkWhiteboardView): string {
    return JSON.stringify([view.originParticipantId, view.originEpoch]);
  }

  #origin(view: ChalkWhiteboardView): Position | undefined {
    if (!view.originParticipantId) return undefined;
    const origin = view.originConnectionId && view.originLeadStamp ? { connectionId: view.originConnectionId, lead: BigInt(view.originLeadStamp.slice(0, view.originLeadStamp.indexOf(":"))) } : this.#epochs.get(this.#epoch(view));
    return origin && { ...origin, sequence: view.originSequence };
  }

  isRetired(view: ChalkWhiteboardView): boolean {
    if (!view.originParticipantId) return false;
    const origin = this.#origin(view);
    const current = this.#participants.get(view.originParticipantId);
    if (!origin) return false;
    const applied = this.#appliedTabs.get(JSON.stringify([view.originParticipantId, origin.connectionId]));
    return (applied !== undefined && origin.sequence < applied) || (current !== undefined && origin.connectionId !== current.connectionId && before(origin, current));
  }

  isNew(view: ChalkWhiteboardView): boolean {
    if (!view.originParticipantId) return true;
    if (this.isRetired(view)) return false;
    const origin = this.#origin(view);
    if (origin !== undefined) {
      if (origin.sequence <= (this.#appliedTabs.get(JSON.stringify([view.originParticipantId, origin.connectionId])) ?? 0)) return false;
      const applied = this.#participants.get(view.originParticipantId)?.applied;
      return !applied || compare(origin, applied) > 0;
    }
    return view.originSequence > (this.#sequences.get(this.#epoch(view)) ?? 0);
  }

  /** Consume only a view the Board applied, not one ignored while following a relay. */
  remember(view: ChalkWhiteboardView, _publisherId?: string): void {
    if (!view.originParticipantId || !this.isNew(view)) return;
    const origin = this.#origin(view);
    if (origin) this.#retain(this.#appliedTabs, JSON.stringify([view.originParticipantId, origin.connectionId]), origin.sequence);
    const current = this.#participants.get(view.originParticipantId);
    if (origin !== undefined && current) {
      this.#retain(this.#participants, view.originParticipantId, { ...current, applied: { ...origin, sequence: view.originSequence } });
    } else {
      this.#retain(this.#sequences, this.#epoch(view), view.originSequence);
    }
  }

  /** Learn proof metadata before duplicate filtering, including cached legacy epochs. */
  observe(view: ChalkWhiteboardView, _publisherId?: string): boolean {
    if (!view.originParticipantId) return false;
    const origin = this.#origin(view);
    if (origin === undefined) return false;
    const epoch = this.#epoch(view);
    if (view.originEpoch) this.#learnEpoch(epoch, origin);
    const position = { ...origin, sequence: view.originSequence };
    if (!this.#observeTab(view.originParticipantId, position)) return false;
    const current = this.#participants.get(view.originParticipantId);
    if (current && before(position, current)) return false;
    const changed = current !== undefined && current.connectionId !== position.connectionId;
    const applied = this.#promoteLegacy(epoch, origin, current?.applied);
    this.#retain(this.#participants, view.originParticipantId, { ...position, applied });
    return changed;
  }

  #observeTab(participantId: string, position: Position): boolean {
    const key = JSON.stringify([participantId, position.connectionId]);
    const previous = this.#tabs.get(key);
    if (position.sequence <= 0 || (previous && position.sequence < previous.sequence)) return false;
    this.#retain(this.#tabs, key, position);
    return true;
  }

  #learnEpoch(epoch: string, origin: Position): void {
    const known = this.#epochs.get(epoch);
    this.#retain(this.#epochs, epoch, known && compare(origin, known) < 0 ? known : origin);
  }

  #promoteLegacy(epoch: string, origin: Origin, applied: Position | undefined): Position | undefined {
    const sequence = this.#sequences.get(epoch);
    if (sequence === undefined) return applied;
    const legacy = { ...origin, sequence };
    return !applied || before(applied, legacy) ? legacy : applied;
  }

  forgetParticipant(participantId: string): void {
    this.#participants.delete(participantId);
    for (const history of [this.#sequences, this.#epochs, this.#tabs, this.#appliedTabs]) {
      for (const key of history.keys()) if (JSON.parse(key)[0] === participantId) history.delete(key);
    }
  }

  #retain<T>(history: Map<string, T>, key: string, value: T): void {
    history.delete(key);
    history.set(key, value);
    if (history.size > 256) {
      const oldest = history.keys().next().value;
      if (oldest !== undefined) history.delete(oldest);
    }
  }
}
