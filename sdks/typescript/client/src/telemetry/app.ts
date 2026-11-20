import type { TelemetryOutbox } from "./outbox";
import type { TelemetryEvent } from "./types";

/** What the app reports about itself. Each report leaves at once, because a crash or a problem report is often followed by a closed tab. */
export type AppTelemetry = {
  /** Names this client in a problem report, so support can find its events. */
  readonly sessionId: string;
  readonly problemReported: () => void;
  readonly renderCrashed: (cause: NonNullable<TelemetryEvent["render_cause"]>) => void;
  /** Records the release gate for an explicit Rejoin, under the previous seat's credential. */
  readonly rejoinRelease?: (result: NonNullable<TelemetryEvent["rejoin_release"]>) => void;
};

export const appTelemetry = (outbox: TelemetryOutbox): AppTelemetry => ({
  sessionId: outbox.sessionId,
  problemReported: () => {
    outbox.record({ type: "problem_reported" });
    void outbox.flush();
  },
  renderCrashed: (cause) => {
    outbox.record({ type: "render_crashed", render_cause: cause });
    void outbox.flush();
  },
  rejoinRelease: (result) => {
    outbox.record({ type: "rejoin_release", rejoin_release: result });
    void outbox.flush();
  },
});
