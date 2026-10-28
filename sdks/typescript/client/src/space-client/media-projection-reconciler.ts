import type { ConnectionReportTransportEvent } from "../transport-diagnostics";

type Source = "microphone" | "camera";
type Observation = {
  readonly revision: number;
  readonly publicationId: string | null;
  readonly enabled: boolean;
  readonly projectedEnabled: boolean;
  readonly projectedPublicationId: string | null;
};
type Mismatch = {
  observation: Observation;
  readonly startedAt: number;
  attempts: number;
  inFlight: boolean;
  reported: boolean;
  failed: boolean;
  timer: unknown;
  readonly controller: AbortController;
};
type Options = {
  readonly now: () => number;
  readonly schedule: (callback: () => void, milliseconds: number) => unknown;
  readonly cancel: (timer: unknown) => void;
  readonly send: (source: Source, observation: Observation, signal: AbortSignal) => Promise<void>;
  readonly report: (event: ConnectionReportTransportEvent) => void;
  readonly changed: () => void;
};

const GRACE_MS = 750;
const REPORT_AFTER_MS = 2000;
const DEADLINE_MS = 8000;
const MAX_ATTEMPTS = 3;

/** Publication truth is reconciled with the server projection, never inferred from an ack. */
export class MediaProjectionReconciler {
  readonly #options: Options;
  readonly #mismatches = new Map<Source, Mismatch>();

  constructor(options: Options) {
    this.#options = options;
  }

  observe(source: Source, observation: Observation | null): void {
    const previous = this.#mismatches.get(source);
    if (!observation || (observation.enabled === observation.projectedEnabled && (!observation.enabled || observation.publicationId === observation.projectedPublicationId))) {
      this.#clear(source);
      return;
    }
    if (previous && previous.observation.revision === observation.revision && previous.observation.publicationId === observation.publicationId && previous.observation.enabled === observation.enabled) {
      previous.observation = observation;
      return;
    }
    this.#clear(source);
    const mismatch: Mismatch = { observation, startedAt: this.#options.now(), attempts: 0, inFlight: false, reported: false, failed: false, timer: undefined, controller: new AbortController() };
    this.#mismatches.set(source, mismatch);
    mismatch.timer = this.#options.schedule(() => this.#tick(source, mismatch), GRACE_MS);
  }

  state(source: Source): "requesting" | "failed" | null {
    const mismatch = this.#mismatches.get(source);
    return mismatch ? (mismatch.failed ? "failed" : "requesting") : null;
  }

  isCurrent(source: Source, observation: Observation): boolean {
    const mismatch = this.#mismatches.get(source);
    return !!mismatch && !mismatch.failed && mismatch.observation.revision === observation.revision && mismatch.observation.publicationId === observation.publicationId && mismatch.observation.enabled === observation.enabled;
  }

  reset(): void {
    for (const source of this.#mismatches.keys()) this.#clear(source);
  }

  #clear(source: Source): void {
    const mismatch = this.#mismatches.get(source);
    this.#mismatches.delete(source);
    if (mismatch) {
      this.#options.cancel(mismatch.timer);
      mismatch.controller.abort();
    }
  }

  #tick(source: Source, mismatch: Mismatch): void {
    if (this.#mismatches.get(source) !== mismatch) return;
    const duration = this.#options.now() - mismatch.startedAt;
    if (duration >= DEADLINE_MS || (mismatch.attempts >= MAX_ATTEMPTS && !mismatch.inFlight)) {
      mismatch.failed = true;
      mismatch.controller.abort();
      this.#report(source, mismatch, "failed");
      this.#options.changed();
      return;
    }
    if (duration >= REPORT_AFTER_MS && !mismatch.reported) {
      mismatch.reported = true;
      this.#report(source, mismatch, "started");
    }
    // One in-flight target per source. Ordinary snapshots cannot replenish the budget.
    mismatch.timer = this.#options.schedule(() => this.#tick(source, mismatch), 1000);
    if (mismatch.inFlight || mismatch.attempts >= MAX_ATTEMPTS) return;
    mismatch.attempts += 1;
    mismatch.inFlight = true;
    void this.#options
      .send(source, mismatch.observation, mismatch.controller.signal)
      .catch(() => {
        // Failure is represented by the bounded attempt budget and terminal UI state.
      })
      .finally(() => {
        mismatch.inFlight = false;
      });
  }

  #report(source: Source, mismatch: Mismatch, outcome: "started" | "failed"): void {
    this.#options.report({
      event: "media_projection_mismatch",
      source,
      publication_state: mismatch.observation.enabled ? "on" : "off",
      projection_state: mismatch.observation.projectedEnabled ? "on" : "off",
      duration_ms: this.#options.now() - mismatch.startedAt,
      attempt: mismatch.attempts,
      outcome,
    });
  }
}
