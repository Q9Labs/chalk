import type { ChalkWhiteboardView } from "./types";

/** Owner sequences are compared only within a connection's authoritative snapshot. */
export class ChalkWhiteboardViewVersions {
  readonly #versions = new Map<string, number>();

  isNew(view: ChalkWhiteboardView, participantId?: string): boolean {
    const key = this.#key(view, participantId);
    const sequence = view.ownerSequence ?? view.originSequence;
    return key === undefined || sequence === undefined || sequence > (this.#versions.get(key) ?? 0);
  }

  remember(view: ChalkWhiteboardView, participantId?: string): void {
    const key = this.#key(view, participantId);
    const sequence = view.ownerSequence ?? view.originSequence;
    if (key === undefined || sequence === undefined || !this.isNew(view, participantId)) return;
    this.#versions.delete(key);
    this.#versions.set(key, sequence);
    if (this.#versions.size > 256) {
      const oldest = this.#versions.keys().next().value;
      if (oldest !== undefined) this.#versions.delete(oldest);
    }
  }

  forgetParticipant(participantId: string): void {
    for (const key of this.#versions.keys()) {
      if (key.startsWith(`${participantId}:`) || key.endsWith(`:${participantId}`)) this.#versions.delete(key);
    }
  }

  clear(): void {
    this.#versions.clear();
  }

  #key(view: ChalkWhiteboardView, participantId?: string): string | undefined {
    if (view.ownerId && participantId) return `${view.ownerId}:${participantId}`;
    return view.originParticipantId ? `${view.originParticipantId}:${view.originEpoch ?? ""}` : undefined;
  }
}
