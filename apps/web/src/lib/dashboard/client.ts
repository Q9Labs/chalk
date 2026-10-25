import type {
  AllowedWebsitesDTO,
  RecordingRenderSettingsDTO,
  ArtifactURLDTO,
  CallAction,
  CallDTO,
  CallPageDTO,
  CallStatusDTO,
  CallMetadataDTO,
  CallMetadataQuery,
  HomeStatusDTO,
  CueDTO,
  DeliveryDTO,
  DeveloperAction,
  DeveloperDTO,
  HomeAction,
  HomeDTO,
  OwnerAccessDTO,
  PastSessionAction,
  PastSessionDTO,
  RecordingDTO,
  SecretDTO,
  SessionDTO,
  TranscriptDTO,
  WebhookDTO,
} from "./contracts";

// The browser half of the dashboard. It holds only the session-bound CSRF token, never a secret:
// the sealed session and every engine credential stay in HttpOnly cookies and the Pages Functions.

export type Provider = "google" | "apple";

type Pages = {
  "call-metadata": { query: CallMetadataQuery; data: CallMetadataDTO; action: never };
  "call-status": { query: { spaceId: string }; data: CallStatusDTO; action: never };
  "call-invite": { query: { spaceId: string }; data: Pick<CallPageDTO, "inviteUrl">; action: never };
  "home-status": { query: { spaceIds?: string; home?: "1" }; data: HomeStatusDTO; action: never };
  home: { query: { cursor?: string }; data: HomeDTO; action: HomeAction };
  call: { query: { spaceId: string; cursor?: string }; data: CallPageDTO; action: CallAction };
  "past-session": { query: { spaceId: string; episodeId: string; cursor?: string }; data: PastSessionDTO; action: PastSessionAction };
  developer: { query: { keyCursor?: string; webhookCursor?: string }; data: DeveloperDTO; action: DeveloperAction };
};
export type DashboardPage = keyof Pages;

type Ok = { ok: true };
type DeliveryDetailDTO = { id: string; state: string; eventType: string; attemptCount: number; attempts: { status: number | null; errorCode: string | null; finishedAt: string | null }[] };

/** What each action returns, as the server branch's handlers build it. The contract doesn't export these yet. */
type Results = {
  "create-call": { call: CallDTO };
  "rename-call": { call: CallDTO };
  "set-admission": { call: CallDTO };
  "archive-call": { call: CallDTO };
  "restore-call": { call: CallDTO };
  join: OwnerAccessDTO;
  "refresh-access": OwnerAccessDTO;
  "rotate-link": { inviteUrl: string };
  "end-for-everyone": Ok;
  "approve-knock": Ok;
  "deny-knock": Ok;
  "create-transcript": { transcript: TranscriptDTO };
  "recording-url": ArtifactURLDTO;
  "export-recording": { recording: RecordingDTO };
  transcripts: { transcripts: TranscriptDTO[] };
  "transcript-document": { cues: CueDTO[] };
  "transcript-url": ArtifactURLDTO;
  "delete-transcript": Ok;
  "allowed-websites": AllowedWebsitesDTO;
  "set-allowed-websites": AllowedWebsitesDTO;
  "set-recording-render-mode": RecordingRenderSettingsDTO;
  "create-key": SecretDTO;
  "rotate-key": SecretDTO;
  "revoke-key": Ok;
  "create-webhook": { webhook: WebhookDTO; secret: string };
  "update-webhook": { webhook: WebhookDTO };
  "delete-webhook": Ok;
  "rotate-webhook-secret": SecretDTO;
  "test-webhook": { deliveryId: string };
  "webhook-deliveries": { deliveries: DeliveryDTO[]; nextCursor: string | null };
  "webhook-delivery": DeliveryDetailDTO;
  "redeliver-webhook": { deliveryId: string };
};

/** A failed dashboard request, with the server's error code. */
export class DashboardRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "DashboardRequestError";
  }
}

const RETURN_PATH = /^\/dashboard(?:\/[a-zA-Z0-9/_-]*)?$/;

/** The sign-in redirect for a provider. `returnTo` must be a dashboard path, as `/auth/start` accepts. */
export function signInURL(provider: Provider, returnTo = "/dashboard"): string {
  const query = new URLSearchParams({ provider, returnTo: RETURN_PATH.test(returnTo) ? returnTo : "/dashboard" });
  return `/auth/start?${query}`;
}

let csrfToken: string | undefined;

/** The signed-in person, or a `sign_in_required` error. Expired sessions require a new sign-in. */
export async function loadSession(): Promise<SessionDTO> {
  const response = await fetch("/auth/session", { headers: { Accept: "application/json" }, cache: "no-store" });
  const body: unknown = await readJSON(response);
  if (response.ok && isSession(body)) {
    csrfToken = body.csrfToken;
    return body;
  }
  throw toError(response, body);
}

export async function signOut(): Promise<void> {
  const response = await post("/auth/sign-out", {});
  if (!response.ok) throw toError(response, await readJSON(response));
  csrfToken = undefined;
}

export async function readPage<P extends DashboardPage>(page: P, query: Pages[P]["query"]): Promise<Pages[P]["data"]> {
  return (await readPageTimed(page, query)).data;
}

/** A page read with the server's clock offset: its `Date` header minus this page's clock, or null without one. */
export async function readPageTimed<P extends DashboardPage>(page: P, query: Pages[P]["query"]): Promise<{ data: Pages[P]["data"]; offset: number | null }> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === "string") search.set(key, value);
  const suffix = search.size ? `?${search}` : "";
  const response = await fetch(`/dashboard-api/${page}${suffix}`, { headers: { Accept: "application/json" }, cache: "no-store" });
  const served = Date.parse(response.headers.get("Date") ?? "");
  const offset = Number.isFinite(served) ? served - Date.now() : null;
  return { data: await send(async () => response), offset };
}

export async function act<P extends DashboardPage, A extends Pages[P]["action"]>(page: P, action: A): Promise<Results[A["action"]]> {
  if (!csrfToken) await loadSession();
  return send(() => post(`/dashboard-api/${page}`, action));
}

async function send<T>(request: () => Promise<Response>): Promise<T> {
  const response = await request();
  if (!response.ok) throw toError(response, await readJSON(response));
  // The server's handlers build these shapes from the contract types, on this same origin.
  return response.json();
}

function post(path: string, body: object): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": csrfToken ?? "" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
}

async function readJSON(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toError(response: Response, body: unknown): DashboardRequestError {
  const code = errorCode(body) ?? (response.status >= 500 ? "service_unavailable" : "request_failed");
  const retryAfter = body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object" && "retryAfterSeconds" in body.error && typeof body.error.retryAfterSeconds === "number" ? body.error.retryAfterSeconds : undefined;
  const header = response.headers.get("Retry-After");
  const seconds = header === null ? NaN : Number(header);
  const date = header === null ? NaN : Date.parse(header);
  const headerDelay = Number.isFinite(seconds) && seconds >= 0 ? seconds : Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
  return new DashboardRequestError(response.status, code, headerDelay ?? (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined));
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined;
  const { error } = body;
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function isSession(body: unknown): body is SessionDTO {
  return Boolean(body && typeof body === "object" && "csrfToken" in body && typeof body.csrfToken === "string" && "profile" in body && body.profile && typeof body.profile === "object");
}

/**
 * How a failed read ends, sorted once for every page: a lost session signs in again and stops all reads, any other
 * client error is final for what was read, and server, network and rate-limit failures are retried with backoff.
 */
export function failureKind(error: unknown): "sign-in" | "terminal" | "transient" {
  if (needsSignIn(error)) return "sign-in";
  if (error instanceof DashboardRequestError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) return "terminal";
  return "transient";
}

/** Whether the person has to sign in again before anything else works. */
export function needsSignIn(error: unknown): boolean {
  return error instanceof DashboardRequestError && error.status === 401 && ["sign_in_required", "session_binding_mismatch"].includes(error.code);
}

/** Plain words for a failed request, with the wait when the engine is rate limiting. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof DashboardRequestError)) return "Check your connection, then try again.";
  if (error.code === "engine_rate_limited" || error.status === 429) {
    const seconds = error.retryAfterSeconds ?? 60;
    return `Chalk is getting a lot of requests. Try again in ${seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`}.`;
  }
  if (error.code === "fresh_sign_in_required") return "Sign in again to make this change. It keeps your account safe.";
  if (error.code === "identity_temporarily_unavailable") return "Sign-in is briefly unavailable. Try again in a moment.";
  if (error.code === "admission_pending") return "The call is still letting you in. Try again in a moment.";
  if (error.code === "api_key_invalid_expiry") return "API key expiry must be in the future and no more than 365 days from now.";
  if (error.code === "invalid_request") return "Check the values you entered, then try again.";
  if (error.status === 404) return "This isn’t here anymore. It may have been archived.";
  if (error.status >= 500) return "Chalk couldn’t finish that. Try again in a moment.";
  return "That didn’t work. Check your connection, then try again.";
}

/** A new idempotency key for one user intent; reuse it when retrying that same intent. */
export function intentKey(): string {
  return crypto.randomUUID();
}
