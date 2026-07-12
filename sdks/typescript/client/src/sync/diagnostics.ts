export type SyncDiagnostic = {
  readonly at: number;
  readonly kind: "connection" | "recovery" | "command" | "protocol" | "persistence";
  readonly code: string;
  readonly details: Readonly<Record<string, boolean | number | string>>;
};

export type SyncDiagnostics = {
  readonly entries: readonly SyncDiagnostic[];
  readonly dropped: number;
};

export class SyncDiagnosticBuffer {
  readonly #entries: SyncDiagnostic[] = [];
  #dropped = 0;

  constructor(readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("diagnostic capacity must be a positive integer");
    }
  }

  add(entry: SyncDiagnostic): void {
    if (this.#entries.length === this.capacity) {
      this.#entries.shift();
      this.#dropped += 1;
    }

    this.#entries.push({ ...entry, details: { ...entry.details } });
  }

  snapshot(): SyncDiagnostics {
    return {
      entries: this.#entries.map((entry) => ({ ...entry, details: { ...entry.details } })),
      dropped: this.#dropped,
    };
  }
}
