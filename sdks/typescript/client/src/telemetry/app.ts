import type { Kernel } from "../obs/kernel";
import { SDK_VERSION } from "../version";
import type { TelemetryOutbox } from "./outbox";
import type { TelemetryEvent } from "./types";

/** What a stored report leaves on the `client.problem_reported` fact: its journey, row id and CHK code copy the API's answer. */
export type ReportedProblem = {
  readonly journeyId?: string;
  readonly reportId?: string;
  readonly code?: string;
  readonly pickedSymptom?: string;
};

/** What the app reports about itself. Each report leaves at once, because a crash or a problem report is often followed by a closed tab. */
export type AppTelemetry = {
  /** Names this client in a problem report, so support can find its events. */
  readonly sessionId: string;
  /** The SDK package version a report body names as `sdk_version`. */
  readonly sdkVersion: string;
  /** The app version the kernel stamps as `app_version`, when the app supplied one. */
  readonly appVersion?: string;
  /** The client's registry kernel. Absent only where a platform supplied no outbox. */
  readonly obs?: Kernel;
  readonly problemReported: (report?: ReportedProblem) => void;
  readonly renderCrashed: (cause: NonNullable<TelemetryEvent["render_cause"]>) => void;
};

export const appTelemetry = (outbox: TelemetryOutbox): AppTelemetry => ({
  sessionId: outbox.clientSessionId,
  sdkVersion: outbox.buildInfo.sdk_version ?? SDK_VERSION,
  ...(outbox.buildInfo.app_version ? { appVersion: outbox.buildInfo.app_version } : {}),
  obs: outbox.obs,
  problemReported: (report) => {
    if (report?.journeyId) outbox.obs.fact("client.problem_reported", { journey_id: report.journeyId, ...(report.reportId ? { report_id: report.reportId } : {}), ...(report.code ? { chk_code: report.code } : {}), ...(report.pickedSymptom ? { picked_symptom: report.pickedSymptom } : {}) });
    outbox.record({ type: "problem_reported" });
    void outbox.flush();
  },
  renderCrashed: (cause) => {
    outbox.record({ type: "render_crashed", render_cause: cause });
    void outbox.flush();
  },
});
