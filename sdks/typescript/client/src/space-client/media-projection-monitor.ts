import type { ConnectionReportTransportEvent } from "../transport-diagnostics";

type Source = "microphone" | "camera";
type Observation = {
  readonly revision: number;
  readonly publicationId: string | null;
  readonly enabled: boolean;
  readonly projectedEnabled: boolean;
  readonly projectedPublicationId: string | null;
};
type Mismatch = { observation: Observation; readonly startedAt: number; readonly timer: unknown };
type Action = { readonly revision: number; mismatch: Mismatch | null; reported: boolean; failed: boolean };
type Options = {
  readonly now: () => number;
  readonly schedule: (callback: () => void, milliseconds: number) => unknown;
  readonly cancel: (timer: unknown) => void;
  readonly report: (event: ConnectionReportTransportEvent) => void;
  readonly pause: (source: Source, revision: number) => void;
  readonly changed: () => void;
};

const GRACE_MS = 2000;

function projectionMatches(observation: Observation): boolean {
  return observation.enabled === observation.projectedEnabled && (!observation.enabled || observation.publicationId === observation.projectedPublicationId);
}

/** Observes authority without sending targets that could affect another client. */
export class MediaProjectionMonitor {
  readonly #options: Options;
  readonly #actions = new Map<Source, Action>();

  constructor(options: Options) {
    this.#options = options;
  }

  observe(source: Source, observation: Observation): void {
    let action = this.#actions.get(source);
    if (action?.revision !== observation.revision) {
      this.#clear(source);
      action = { revision: observation.revision, mismatch: null, reported: false, failed: false };
      this.#actions.set(source, action);
    }
    // A publication change or a late confirmation cannot restore revoked consent.
    if (action.failed) return;
    if (projectionMatches(observation)) {
      if (action.mismatch) this.#options.cancel(action.mismatch.timer);
      action.mismatch = null;
      return;
    }
    if (action.mismatch) {
      action.mismatch.observation = observation;
      if (observation.enabled && this.#options.now() - action.mismatch.startedAt >= GRACE_MS) this.#expire(source, action);
      return;
    }
    // Publication churn must not move the grace deadline for this action.
    const timer = this.#options.schedule(() => this.#expire(source, action), GRACE_MS);
    action.mismatch = { observation, startedAt: this.#options.now(), timer };
  }

  state(source: Source): "requesting" | "failed" | null {
    const action = this.#actions.get(source);
    if (action?.failed) return "failed";
    return action?.mismatch?.observation.enabled ? "requesting" : null;
  }

  reset(): void {
    for (const source of this.#actions.keys()) this.#clear(source);
  }

  #clear(source: Source): void {
    const action = this.#actions.get(source);
    if (action?.mismatch) this.#options.cancel(action.mismatch.timer);
    this.#actions.delete(source);
  }

  #expire(source: Source, action: Action): void {
    if (this.#actions.get(source) !== action || !action.mismatch) return;
    const { observation, startedAt } = action.mismatch;
    action.failed = observation.enabled;
    if (observation.enabled) this.#options.pause(source, observation.revision);
    if (!action.reported) {
      action.reported = true;
      this.#options.report({
        event: "media_projection_mismatch",
        source,
        publication_state: observation.enabled ? "on" : "off",
        projection_state: observation.projectedEnabled ? "on" : "off",
        duration_ms: this.#options.now() - startedAt,
        attempt: 0,
        outcome: observation.enabled ? "failed" : "started",
      });
    }
    this.#options.changed();
  }
}
