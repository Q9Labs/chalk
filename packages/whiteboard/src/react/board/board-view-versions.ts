import type { WhiteboardView as ChalkWhiteboardView } from "../../collab/view";

/** A bounded record of the latest applied version, not a history of received frames. */
export class ViewVersions {
  readonly #versions = new Map<string, number>();

  isNew(view: ChalkWhiteboardView): boolean {
    if (!view.originParticipantId) return true;
    return view.originSequence > (this.#versions.get(`${view.originParticipantId}:${view.originEpoch ?? ""}`) ?? 0);
  }

  remember(view: ChalkWhiteboardView): void {
    if (!view.originParticipantId || !this.isNew(view)) return;
    const origin = `${view.originParticipantId}:${view.originEpoch ?? ""}`;
    this.#versions.delete(origin);
    this.#versions.set(origin, view.originSequence);
    if (this.#versions.size > 256) {
      const oldest = this.#versions.keys().next().value;
      if (oldest !== undefined) this.#versions.delete(oldest);
    }
  }
}
