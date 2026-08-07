import {
  fingerprintDiagnosticFilter,
  parseAgentBrief,
  parseDiagnosticEventPage,
  parseDiagnosticExportJob,
  parseDiagnosticOperationPage,
  parseDiagnosticResolverResponse,
  parseDiagnosticReference,
  parseDiagnosticSnapshot,
  parseDiagnosticStreamDelta,
  parseStreamClose,
  parseStreamControl,
  renderAgentBriefMarkdown,
  type AgentBriefResponseV1,
  type DiagnosticEventPageV1,
  type DiagnosticExportStatus,
  type DiagnosticFilterV1,
  type DiagnosticOperationPageV1,
  type DiagnosticResolverResponseV1,
  type DiagnosticSnapshotV1,
  type DiagnosticStreamDeltaV1,
} from "@chalk/diagnostics-contracts";
import { decodeServerSentEvents } from "./sse";

export class EpisodeDiagnosticsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "EpisodeDiagnosticsApiError";
  }
}

export class EpisodeDiagnosticsStreamClosedError extends EpisodeDiagnosticsApiError {
  constructor(
    readonly reason: string,
    readonly resumableCursor: number,
    readonly refillRequired: boolean,
  ) {
    super(`The diagnostic stream closed: ${reason}`);
    this.name = "EpisodeDiagnosticsStreamClosedError";
  }
}

type ApiClientOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  basePath?: string;
}>;

type PageQuery = Readonly<{
  after?: number;
  before?: number;
  limit?: number;
  filter?: DiagnosticFilterV1;
}>;

type BriefQuery = Readonly<{
  cursor?: number;
  aroundSeconds?: number;
  branchId?: string;
  signal?: AbortSignal;
}>;

const CSRF_REFRESH_MS = 55 * 60 * 1000;

const encodeFilter = (filter: DiagnosticFilterV1 | undefined): string | undefined => (filter ? JSON.stringify(filter) : undefined);

const addQuery = (url: URL, values: Readonly<Record<string, string | number | undefined>>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
};

export class EpisodeDiagnosticsApiClient {
  private readonly request: typeof globalThis.fetch;
  private readonly basePath: string;
  private csrfToken: string | undefined;
  private csrfExpiresAt = 0;

  constructor(options: ApiClientOptions = {}) {
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.basePath = options.basePath ?? "/_internal/episode-diagnostics";
    const browserOrigin = globalThis.location?.origin ?? "http://localhost";
    if (new URL(this.basePath, browserOrigin).origin !== browserOrigin) {
      throw new EpisodeDiagnosticsApiError("Episode Diagnostics requires a same-origin environment gateway");
    }
  }

  async readSnapshot(reference: string, filter?: DiagnosticFilterV1, signal?: AbortSignal): Promise<DiagnosticSnapshotV1> {
    const url = this.referenceUrl(reference);
    addQuery(url, { filters: encodeFilter(filter) });
    const response = parseDiagnosticResolverResponse(await this.fetchJson(url, { signal }));
    if (response.kind === "not_found") {
      throw new EpisodeDiagnosticsApiError(`Diagnostic evidence is unavailable: ${response.reason}`, 404, response.reason);
    }
    return parseDiagnosticSnapshot(response.snapshot);
  }

  async resolve(reference: string, signal?: AbortSignal): Promise<DiagnosticResolverResponseV1> {
    return parseDiagnosticResolverResponse(await this.fetchJson(this.referenceUrl(reference), { signal }));
  }

  async resolveAlternate(alternateReference: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(`${this.basePath.replace(/\/$/, "")}/resolve/${encodeURIComponent(alternateReference)}`, globalThis.location?.origin ?? "http://localhost");
    const input = await this.fetchJson(url, { signal });
    if (!input || typeof input !== "object" || (input as Record<string, unknown>).schemaVersion !== "DiagnosticReference/v1" || typeof (input as Record<string, unknown>).reference !== "string") {
      throw new EpisodeDiagnosticsApiError("The alternate resolver returned a malformed Diagnostic Reference");
    }
    const reference = (input as Record<string, unknown>).reference as string;
    parseDiagnosticReference(reference);
    return reference;
  }

  async readEvents(reference: string, query: PageQuery, signal?: AbortSignal): Promise<DiagnosticEventPageV1> {
    const url = this.referenceUrl(reference, "events");
    addQuery(url, {
      after: query.after,
      before: query.before,
      limit: Math.min(query.limit ?? 1_000, 1_000),
      filters: encodeFilter(query.filter),
    });
    return parseDiagnosticEventPage(await this.fetchJson(url, { signal }));
  }

  async readOperations(reference: string, query: PageQuery, signal?: AbortSignal): Promise<DiagnosticOperationPageV1> {
    const url = this.referenceUrl(reference, "operations");
    addQuery(url, {
      after: query.after,
      limit: Math.min(query.limit ?? 250, 1_000),
      filters: encodeFilter(query.filter),
    });
    return parseDiagnosticOperationPage(await this.fetchJson(url, { signal }));
  }

  async readBrief(reference: string, format: "compact" | "markdown", query: BriefQuery = {}): Promise<AgentBriefResponseV1> {
    const url = this.referenceUrl(reference, "brief");
    addQuery(url, { format, cursor: query.cursor, around_seconds: query.aroundSeconds, branch_id: query.branchId });
    const input = await this.fetchJson(url, { signal: query.signal });
    if (!input || typeof input !== "object") {
      throw new EpisodeDiagnosticsApiError("The AgentBrief response was not an object");
    }
    const record = input as Record<string, unknown>;
    if (record.format !== format) {
      throw new EpisodeDiagnosticsApiError("The AgentBrief format did not match the request");
    }
    const brief = parseAgentBrief(record.brief);
    return {
      schemaVersion: "AgentBriefResponse/v1",
      format,
      brief,
      ...(format === "markdown" ? { markdown: renderAgentBriefMarkdown(brief) } : {}),
    };
  }

  async createExportJob(reference: string, cursorTo?: number, signal?: AbortSignal): Promise<DiagnosticExportStatus> {
    const url = this.referenceUrl(reference, "export-jobs");
    const response = await this.fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "ExportJobRequest/v1", cursorTo }),
      signal,
    });
    return parseDiagnosticExportJob(response);
  }

  async readExportJob(reference: string, jobId: string, signal?: AbortSignal): Promise<DiagnosticExportStatus> {
    return parseDiagnosticExportJob(
      await this.fetchJson(this.referenceUrl(reference, `export-jobs/${encodeURIComponent(jobId)}`), {
        signal,
      }),
    );
  }

  async cancelExportJob(reference: string, jobId: string, signal?: AbortSignal): Promise<DiagnosticExportStatus> {
    return parseDiagnosticExportJob(
      await this.fetchJson(this.referenceUrl(reference, `export-jobs/${encodeURIComponent(jobId)}`), {
        method: "DELETE",
        signal,
      }),
    );
  }

  exportDownloadUrl(reference: string, jobId: string): string {
    return this.referenceUrl(reference, `export-jobs/${encodeURIComponent(jobId)}/download`).toString();
  }

  async *stream(reference: string, afterCursor: number, filter: DiagnosticFilterV1, signal?: AbortSignal, onActivity?: () => void): AsyncGenerator<DiagnosticStreamDeltaV1> {
    const url = this.referenceUrl(reference, "stream");
    addQuery(url, { after: afterCursor, filters: encodeFilter(filter) });
    const response = await this.request(url, {
      headers: {
        accept: "text/event-stream",
        "last-event-id": String(afterCursor),
      },
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (!response.ok || !response.body) await this.throwResponseError(response);
    if (!response.body) throw new EpisodeDiagnosticsApiError("The live stream had no body");

    for await (const message of decodeServerSentEvents(response.body, onActivity)) {
      if (message.event === "heartbeat") continue;
      let input: unknown;
      try {
        input = JSON.parse(message.data);
      } catch {
        throw new EpisodeDiagnosticsApiError("The live stream sent malformed JSON");
      }
      if (message.event === "control") {
        const control = parseStreamControl(input);
        if (control.filterFingerprint !== fingerprintDiagnosticFilter(filter)) throw new EpisodeDiagnosticsApiError("The live stream control fingerprint changed");
        continue;
      }
      if (message.event === "close") {
        const close = parseStreamClose(input);
        throw new EpisodeDiagnosticsStreamClosedError(close.reason, close.resumableCursor, close.refillRequired);
      }
      const delta = parseDiagnosticStreamDelta(input);
      if (message.id !== undefined && Number(message.id) !== delta.cursor) {
        throw new EpisodeDiagnosticsApiError("The SSE ID did not match the durable cursor");
      }
      yield delta;
    }
  }

  private referenceUrl(reference: string, suffix?: string): URL {
    const base = new URL(this.basePath, globalThis.location?.origin ?? "http://localhost");
    const path = `${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(reference)}`;
    base.pathname = suffix ? `${path}/${suffix}` : path;
    return base;
  }

  private async fetchJson(url: URL, init: RequestInit, retryCSRF = true): Promise<unknown> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (method !== "GET" && method !== "HEAD") headers.set("x-chalk-csrf", await this.getCSRFToken());

    const response = await this.request(url, {
      ...init,
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers,
    });
    if (!response.ok) {
      if (retryCSRF && method !== "GET" && method !== "HEAD" && response.status === 403 && (await this.responseErrorCode(response.clone())) === "csrf.mismatch") {
        this.csrfToken = undefined;
        this.csrfExpiresAt = 0;
        return this.fetchJson(url, init, false);
      }
      await this.throwResponseError(response);
    }
    try {
      return await response.json();
    } catch {
      throw new EpisodeDiagnosticsApiError("The diagnostics API returned malformed JSON");
    }
  }

  private async throwResponseError(response: Response): Promise<never> {
    let code: string | undefined;
    let message = `Episode Diagnostics request failed with ${response.status}`;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
    } catch {
      // The status remains actionable when an intermediary returns a non-JSON body.
    }
    throw new EpisodeDiagnosticsApiError(message, response.status, code);
  }

  private async responseErrorCode(response: Response): Promise<string | undefined> {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      return typeof body.code === "string" ? body.code : undefined;
    } catch {
      return undefined;
    }
  }

  private async getCSRFToken(): Promise<string> {
    if (this.csrfToken && Date.now() < this.csrfExpiresAt) return this.csrfToken;

    const response = await this.request("/api/auth/csrf", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new EpisodeDiagnosticsApiError("Could not secure this request", response.status, "csrf.unavailable");

    let value: { csrf_token?: unknown };
    try {
      value = (await response.json()) as { csrf_token?: unknown };
    } catch {
      throw new EpisodeDiagnosticsApiError("Could not secure this request", 502, "csrf.unavailable");
    }
    if (typeof value.csrf_token !== "string" || value.csrf_token.length === 0) throw new EpisodeDiagnosticsApiError("Could not secure this request", 502, "csrf.unavailable");
    this.csrfToken = value.csrf_token;
    this.csrfExpiresAt = Date.now() + CSRF_REFRESH_MS;
    return value.csrf_token;
  }
}
