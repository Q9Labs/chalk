import type { ParsedAccessGrant } from "../access/grant";
import type { ConnectionDiagnostic } from "./diagnostics";

import type { ConnectionReport, ConnectionReportTransportEvent } from "../transport-diagnostics";
export type { ConnectionReport, ConnectionReportTransportEvent } from "../transport-diagnostics";
type ReportEvent = ConnectionReport["events"][number];
const MAX_EVENTS = 64;
const MAX_BYTES = 32768;
const MAX_MS = 2147483647;
const COOLDOWN_MS = 60000;
// Shared by connections in this SDK instance; bounded even across repeated joins.
const participantCooldowns = new Map<string, number>();
const milliseconds = (value: number) => Math.max(0, Math.min(MAX_MS, Math.round(Number.isFinite(value) ? value : 0)));
const optionalMilliseconds = (value: number | null | undefined) => (value == null ? undefined : milliseconds(value));

function mediaReportFields(media: ConnectionDiagnostic["media"]): Pick<ReportEvent, "media_error_kind" | "media_error_step" | "granted_audio" | "granted_video" | "http_status"> {
  if (!media) return {};
  return {
    media_error_kind: media.media_error_kind,
    media_error_step: media.media_error_step,
    granted_audio: media.granted_audio,
    granted_video: media.granted_video,
    http_status: media.http_status,
  };
}

function reserveParticipantReport(access: ParsedAccessGrant, now: number): boolean {
  const key = `${access.subject.tenantId}:${access.subject.participantId}`;
  for (const [participant, until] of participantCooldowns) if (until <= now) participantCooldowns.delete(participant);
  if (participantCooldowns.has(key)) return false;
  if (participantCooldowns.size >= 128) participantCooldowns.delete(participantCooldowns.keys().next().value ?? "");
  participantCooldowns.set(key, now + COOLDOWN_MS);
  return true;
}

type ReporterOptions = {
  readonly traceparent: string;
  readonly now: () => number;
  readonly access: () => ParsedAccessGrant | null;
  readonly send: (access: ParsedAccessGrant, report: ConnectionReport, signal: AbortSignal, traceparent: string) => Promise<void>;
  readonly online: () => boolean;
  readonly subscribeOnline: (listener: () => void) => () => void;
};

type PendingReport = { readonly access: ParsedAccessGrant; readonly report: ConnectionReport; attempts: number };

/** Only SDK-owned enums and numeric facts enter this buffer. No generic logging. */
export class ConnectionReporter {
  readonly #events: ReportEvent[] = [];
  readonly #startedAt: number;
  readonly #options: ReporterOptions;
  #pending: PendingReport | null = null;
  #unsubscribe: (() => void) | undefined;
  #controller: AbortController | null = null;
  #retryOnReconnect = false;
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
      ...mediaReportFields(diagnostic.media),
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
      ...(event.source == null ? {} : { source: event.source }),
      ...(event.publication_state == null ? {} : { publication_state: event.publication_state }),
      ...(event.projection_state == null ? {} : { projection_state: event.projection_state }),
      ...(event.outcome == null ? {} : { outcome: event.outcome }),
    });
    if (event.event === "media_projection_mismatch") this.#report("media_projection_mismatch");
  }

  dispose(): void {
    this.#disposed = true;
    this.#controller?.abort();
    this.#stopListening();
    this.#pending = null;
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
    if (this.#disposed || this.#pending) return;
    const access = this.#options.access();
    // Never turn diagnostics into an anonymous ingestion or credential-refresh path.
    if (!access) return;
    if (!reserveParticipantReport(access, this.#options.now())) return;
    const events = this.#events.slice();
    const report: ConnectionReport = { version: 1, trigger, events };
    while (events.length && new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_BYTES) events.shift();
    if (!events.length) return;
    this.#pending = { access, report, attempts: 0 };
    this.#unsubscribe = this.#options.subscribeOnline(() => {
      this.#retryOnReconnect = true;
      void this.#flush();
    });
    void this.#flush();
  }
  async #flush(): Promise<void> {
    const pending = this.#pending;
    if (!pending || this.#controller || this.#disposed || !this.#options.online()) return;
    this.#retryOnReconnect = false;
    const controller = new AbortController();
    this.#controller = controller;
    pending.attempts += 1;
    const timer = globalThis.setTimeout(() => controller.abort(), 5000);
    try {
      await this.#options.send(pending.access, pending.report, controller.signal, this.traceparent);
      this.#pending = null;
    } catch {
      // Best effort: one reconnect retry only. Reporting must not recover the call
      // or recursively report its own failures.
      if (pending.attempts >= 2) this.#pending = null;
    } finally {
      globalThis.clearTimeout(timer);
      this.#controller = null;
      if (!this.#pending) this.#stopListening();
      if (this.#retryOnReconnect) void this.#flush();
    }
  }

  #stopListening(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#retryOnReconnect = false;
  }
}
