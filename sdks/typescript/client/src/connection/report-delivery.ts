import type { ParsedAccessGrant } from "../access/grant";
import type { ConnectionReport } from "../transport-diagnostics";
const MAX_BYTES = 32768;
const COOLDOWN_MS = 60000;
// Shared by connections in this SDK instance; bounded even across repeated joins.
const participantCooldowns = new Map<string, number>();
function reserveParticipantReport(access: ParsedAccessGrant, now: number): boolean {
  const key = `${access.subject.tenantId}:${access.subject.participantId}`;
  for (const [participant, until] of participantCooldowns) if (until <= now) participantCooldowns.delete(participant);
  if (participantCooldowns.has(key)) return false;
  if (participantCooldowns.size >= 128) participantCooldowns.delete(participantCooldowns.keys().next().value ?? "");
  participantCooldowns.set(key, now + COOLDOWN_MS);
  return true;
}

export type ReporterOptions = {
  readonly traceparent: string;
  readonly now: () => number;
  readonly access: () => ParsedAccessGrant | null;
  readonly send: (access: ParsedAccessGrant, report: ConnectionReport, signal: AbortSignal, traceparent: string) => Promise<void>;
  readonly online: () => boolean;
  readonly subscribeOnline: (listener: () => void) => () => void;
};

type PendingReport = { readonly access: ParsedAccessGrant; readonly report: ConnectionReport; attempts: number };

// Loaded only after failure and once the browser is online. Capture stays eager.
export class ConnectionReportDelivery {
  readonly #options: ReporterOptions;
  #pending: PendingReport | null = null;
  #unsubscribe: (() => void) | undefined;
  #controller: AbortController | null = null;
  #disposed = false;

  constructor(options: ReporterOptions) {
    this.#options = options;
  }

  dispose(): void {
    this.#disposed = true;
    this.#controller?.abort();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pending = null;
  }

  report(access: ParsedAccessGrant, report: ConnectionReport): void {
    if (this.#disposed || this.#pending || !reserveParticipantReport(access, this.#options.now())) return;
    while (report.events.length && new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_BYTES) report.events.shift();
    if (!report.events.length) return;
    this.#pending = { access, report, attempts: 0 };
    this.#unsubscribe = this.#options.subscribeOnline(() => {
      void this.#flush();
    });
    void this.#flush();
  }
  async #flush(): Promise<void> {
    const pending = this.#pending;
    if (!pending || this.#controller || this.#disposed || !this.#options.online()) return;
    const controller = new AbortController();
    this.#controller = controller;
    pending.attempts += 1;
    const timer = globalThis.setTimeout(() => controller.abort(), 5000);
    try {
      await this.#options.send(pending.access, pending.report, controller.signal, this.#options.traceparent);
      this.#pending = null;
    } catch {
      // Best effort: one reconnect retry only. Reporting must not recover the call
      // or recursively report its own failures.
      if (pending.attempts >= 2) this.#pending = null;
    } finally {
      globalThis.clearTimeout(timer);
      this.#controller = null;
      if (!this.#pending) {
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
      }
    }
  }
}

export async function sendConnectionReport(apiBaseURL: string, grant: ParsedAccessGrant, report: ConnectionReport, signal: AbortSignal, traceparent: string): Promise<void> {
  const response = await fetch(`${apiBaseURL.replace(/\/$/, "")}/v1/tenants/${encodeURIComponent(grant.subject.tenantId)}/connection-reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${grant.media.token}`, "Content-Type": "application/json", traceparent },
    body: JSON.stringify(report),
    signal,
    keepalive: true,
    credentials: "omit",
  });
  // A response (including rejection) is final; retry only transport failures.
  await response.body?.cancel();
}
