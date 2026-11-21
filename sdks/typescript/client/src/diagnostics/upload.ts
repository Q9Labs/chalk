import * as apiUrls from "../api-urls";
import { expected, failure, type Kernel } from "../obs/kernel";
import type { EventFields } from "../obs/registry";
import { withRequestContext } from "../session";

type UploadScope = { readonly set: (fields: Partial<EventFields["report.upload"]>) => void };

/** One stored report or one live request issues at most one diagnostic upload, and its body names that target. */
export type DiagnosticUploadRequest = { readonly trigger: "report"; readonly reportId: string } | { readonly trigger: "live"; readonly liveRequestId: string };

export type IssuedDiagnosticUpload = {
  readonly upload_id: string;
  readonly url: string;
  readonly headers: Record<string, readonly string[]>;
  readonly expires_at?: string;
};

export type DiagnosticUploadOptions = {
  readonly apiBaseURL: string;
  readonly tenantId: string;
  /** The participant's media bearer: `ParsedAccessGrant.media.token`, or web's `mediaProof`. */
  readonly credential: string | (() => string | undefined | Promise<string | undefined>);
  readonly request: DiagnosticUploadRequest;
  /** Builds the gzip bundle. Called after issue so the API row exists before work that can fail. */
  readonly bundle: () => Promise<Uint8Array>;
  readonly obs?: Kernel;
  readonly fetch?: typeof globalThis.fetch;
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
  /** `expected(report.page_hidden)` when the page hides while the op is in flight. */
  readonly isHidden?: () => boolean;
  readonly timeoutMs?: number;
};

export type DiagnosticUploadResult = {
  readonly uploadId: string;
  readonly bytes: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const pageHidden = () => (typeof document === "object" && document !== null ? document.visibilityState === "hidden" : false);

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Issue, build, PUT to the issued URL, then complete. Success means the API stored the object. */
export async function uploadDiagnosticBundle(options: DiagnosticUploadOptions): Promise<DiagnosticUploadResult | undefined> {
  const request = options.request;
  const run = async (scope: UploadScope) => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw failure("report.network");
    // Baggage and traceparent ride only on the Chalk API calls; the issued PUT URL is another origin.
    const apiFetch = withRequestContext(fetchImpl);
    const isHidden = options.isHidden ?? pageHidden;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const post = async (url: string, body: Record<string, unknown>) => {
      const credential = typeof options.credential === "string" ? options.credential : await options.credential();
      if (!credential) throw failure("report.no_credential");
      let response: Response;
      try {
        response = await apiFetch(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${credential}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw failure(error instanceof DOMException && error.name === "TimeoutError" ? "report.timeout" : "report.network", error);
      }
      if (!response.ok) throw failure("report.upload_refused");
      if (isHidden()) throw expected("report.page_hidden");
      return response.json() as Promise<unknown>;
    };
    const issued = (await post(apiUrls.diagnosticUploads(options.apiBaseURL, options.tenantId), request.trigger === "report" ? { trigger: "report", report_id: request.reportId } : { trigger: "live", live_request_id: request.liveRequestId })) as Partial<IssuedDiagnosticUpload>;
    if (typeof issued.upload_id !== "string" || typeof issued.url !== "string") throw failure("report.upload_refused");
    scope.set({ diagnostic_upload_id: issued.upload_id });

    const body = await options.bundle();
    const putHeaders = new Headers({ "content-type": "application/gzip" });
    for (const [name, values] of Object.entries(issued.headers ?? {})) for (const value of values ?? []) putHeaders.append(name, value);
    let put: Response;
    try {
      put = await fetchImpl(issued.url, { method: "PUT", headers: putHeaders, body: body as BodyInit, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw failure(error instanceof DOMException && error.name === "TimeoutError" ? "report.timeout" : "report.network", error);
    }
    scope.set({ http_status: put.status, bytes: body.byteLength });
    if (!put.ok) throw failure("report.upload_refused");
    if (isHidden()) throw expected("report.page_hidden");

    const sha256 = await (options.sha256 ?? sha256Hex)(body);
    const stored = (await post(apiUrls.diagnosticUploadComplete(options.apiBaseURL, options.tenantId, issued.upload_id), { bytes: body.byteLength, sha256 })) as { stored?: boolean };
    if (stored.stored !== true) throw failure("report.upload_refused");
    return { uploadId: issued.upload_id, bytes: body.byteLength };
  };
  if (!options.obs) return run({ set: () => undefined });
  return options.obs.op(
    "report.upload",
    {
      upload_trigger: request.trigger,
      diagnostic_upload_id: "unavailable(not_issued)",
      ...(request.trigger === "report" ? { report_id: request.reportId } : { live_request_id: request.liveRequestId }),
    },
    run,
  );
}
