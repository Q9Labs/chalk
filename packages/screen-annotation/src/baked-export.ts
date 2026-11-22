import { INK_PROOF_TIMEOUT_MS } from "./baked-stroke-proof";

type Ink = { revision?: number; observed: boolean; complete: boolean; deadline: number };

/** Saving may briefly wait for new ink, but never repaints unproved ink over decoded video. */
export class BakedExportProof {
  readonly #ink = new Map<string, Ink>();
  readonly #listeners = new Set<() => void>();

  #entry(id: string): Ink {
    const ink = this.#ink.get(id);
    if (ink) return ink;
    const pending = { observed: false, complete: false, deadline: Date.now() + INK_PROOF_TIMEOUT_MS };
    this.#ink.set(id, pending);
    return pending;
  }

  expect(id: string): void {
    this.#entry(id).observed = true;
  }

  observe(id: string, revision: number): boolean {
    const ink = this.#entry(id);
    ink.revision = revision;
    const needsProof = !ink.observed;
    ink.observed = true;
    return needsProof;
  }

  accepted(id: string, revision: number): void {
    const ink = this.#ink.get(id);
    if (ink) ink.revision = revision;
  }

  settle(id: string): void {
    if (this.#ink.delete(id)) this.#notify();
  }

  finish(id: string): void {
    const ink = this.#ink.get(id);
    if (!ink) return;
    ink.complete = true;
    this.#notify();
  }

  reconcile(revision: number, markIds: ReadonlySet<string>): void {
    for (const [id, ink] of this.#ink) {
      if (ink.revision !== undefined && revision >= ink.revision && !markIds.has(id)) this.settle(id);
    }
  }

  #notify(): void {
    for (const notify of this.#listeners) notify();
  }

  async wait(markIds: readonly string[]): Promise<void> {
    // Include committed marks not observed by the paint hook yet.
    for (const id of markIds) this.#entry(id);
    const pending = new Map(this.#ink);
    const deadline = Math.max(Date.now(), ...[...pending.values()].filter((ink) => !ink.complete).map((ink) => ink.deadline));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve();
      };
      const check = () => {
        const waiting = [...pending].some(([id, ink]) => this.#ink.get(id) === ink && !ink.complete && Date.now() < ink.deadline);
        if (!waiting) finish();
      };
      // At the deadline use the pristine decoded image, even if a mark is
      // missing. Repainting it could darken already-baked translucent ink.
      const timer = setTimeout(finish, remaining);
      this.#listeners.add(check);
    });
  }
}
