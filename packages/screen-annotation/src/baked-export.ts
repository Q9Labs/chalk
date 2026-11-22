const EXPORT_PROOF_TIMEOUT_MS = 4_000;

type Ink = { revision?: number; observed: boolean; confirmed: boolean };

/** Export proof survives the shorter deadline that hides the local preview. */
export class BakedExportProof {
  readonly #ink = new Map<string, Ink>();
  readonly #listeners = new Set<() => void>();

  #entry(id: string): Ink {
    const ink = this.#ink.get(id);
    if (ink) return ink;
    const pending = { observed: false, confirmed: false };
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

  confirm(id: string): void {
    const ink = this.#ink.get(id);
    if (!ink) return;
    ink.confirmed = true;
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

  async wait(markIds: readonly string[] = []): Promise<boolean> {
    // Include marks already in Sync even if the paint hook hasn't observed
    // their commit yet; server acceptance alone never makes a mark safe.
    for (const id of markIds) this.#entry(id);
    const pending = [...this.#ink.values()].filter((ink) => !ink.confirmed);
    if (!pending.length) return true;
    const snapshot = new Set(pending);
    return new Promise((resolve) => {
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(ready);
      };
      const check = () => {
        for (const ink of this.#ink.values()) if (snapshot.has(ink) && !ink.confirmed) return;
        finish(true);
      };
      const timer = setTimeout(() => finish(false), EXPORT_PROOF_TIMEOUT_MS);
      this.#listeners.add(check);
    });
  }
}
