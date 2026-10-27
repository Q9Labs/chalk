import type { ConnectionReportDelivery, ReporterOptions } from "./report-delivery";
import type { ConnectionDiagnostic } from "./diagnostics";

import type { ConnectionReport, ConnectionReportTransportEvent } from "../transport-diagnostics";
export type { ConnectionReport, ConnectionReportTransportEvent } from "../transport-diagnostics";
type ReportEvent = ConnectionReport["events"][number];
const MAX_EVENTS = 64;
const MAX_MS = 2147483647;
const milliseconds = (value: number) => Math.max(0, Math.min(MAX_MS, Math.round(Number.isFinite(value) ? value : 0)));
const optionalMilliseconds = (value: number | null | undefined) => (value == null ? undefined : milliseconds(value));

/** Only SDK-owned enums and numeric facts enter this buffer. No generic logging. */
export class ConnectionReporter {
  readonly #events: ReportEvent[] = [];
  readonly #startedAt: number;
  readonly #options: ReporterOptions;
  #delivery: ConnectionReportDelivery | undefined;
  #waiting = false;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(options: ReporterOptions) {
    this.#options = options;
    this.#startedAt = options.now();
  }

  recordDiagnostic(diagnostic: ConnectionDiagnostic): void {
    this.#record({
      event: diagnostic.event,
      elapsed_ms: this.#elapsed(),
      state: diagnostic.state,
      step: diagnostic.step,
      outcome: diagnostic.outcome,
      code: diagnostic.code,
      attempt: optionalMilliseconds(diagnostic.attempt),
      duration_ms: optionalMilliseconds(diagnostic.sync?.durationMs ?? diagnostic.durationMs),
      close_code: diagnostic.sync?.closeCode ?? undefined,
      heartbeat_gap_ms: optionalMilliseconds(diagnostic.recovery?.lastHeartbeatReplyAgoMs),
    });
    if (diagnostic.event === "recovery_exhausted") this.#report("recovery_exhausted");
    else if (diagnostic.event === "connection_failed") this.#report(diagnostic.state === "joining" ? "join_failed" : "connection_lost");
  }

  recordTransport(event: ConnectionReportTransportEvent): void {
    this.#record({
      event: event.event,
      elapsed_ms: this.#elapsed(),
      ...(event.phase ? { phase: event.phase } : {}),
      ...(event.attempt == null ? {} : { attempt: milliseconds(event.attempt) }),
      ...(event.duration_ms == null ? {} : { duration_ms: milliseconds(event.duration_ms) }),
      ...(event.heartbeat_gap_ms == null ? {} : { heartbeat_gap_ms: milliseconds(event.heartbeat_gap_ms) }),
      ...(event.close_code == null ? {} : { close_code: event.close_code }),
      ...(event.http_status == null ? {} : { http_status: event.http_status }),
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#delivery?.dispose();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#events.length = 0;
  }

  get traceparent(): string {
    return this.#options.traceparent;
  }

  #elapsed(): number {
    return milliseconds(this.#options.now() - this.#startedAt);
  }
  #record(event: ReportEvent): void {
    if (this.#disposed) return;
    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.shift();
  }
  #report(trigger: ConnectionReport["trigger"]): void {
    if (this.#disposed || this.#waiting) return;
    const access = this.#options.access();
    // Never turn diagnostics into an anonymous ingestion or credential-refresh path.
    if (!access) return;
    const report: ConnectionReport = { version: 1, trigger, events: this.#events.slice() };
    if (this.#delivery) {
      this.#delivery.report(access, report);
      return;
    }
    this.#waiting = true;
    const load = () => {
      if (this.#disposed || !this.#options.online()) return;
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      void import("./report-delivery")
        .then(({ ConnectionReportDelivery }) => {
          if (this.#disposed) return;
          this.#delivery = new ConnectionReportDelivery(this.#options);
          this.#waiting = false;
          this.#delivery.report(access, report);
        })
        .catch(() => {
          // Loading failure is best effort too; never interrupt or recover the call.
          this.#waiting = false;
        });
    };
    if (this.#options.online()) load();
    else this.#unsubscribe = this.#options.subscribeOnline(load);
  }
}
