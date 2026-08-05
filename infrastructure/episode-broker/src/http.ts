import { BrokerError, browserCredentialCookie, maximumBodyBytes, maximumDisplayNameLength, type AccessGrantInput, type AccessInput, type BrowserParticipantCredentialInput, type ParticipantCredentialInput, type TraceContext } from "./contracts";

const capabilityPattern = /^[A-Za-z0-9_-]{43}$/u;
const traceparentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u;
const maximumMediaTokenLength = 7_500;

export async function readJSON(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new BrokerError(415, "Content-Type must be application/json.");

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) throw new BrokerError(413, "Request body is too large.");
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBodyBytes) {
      await reader.cancel();
      throw new BrokerError(413, "Request body is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes) || "{}");
  } catch {
    throw new BrokerError(400, "Request body must be valid JSON.");
  }
}

export function browserParticipantCredentialInput(value: unknown): BrowserParticipantCredentialInput {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["displayName", "spaceInviteToken"])) throw new BrokerError(400, "Only displayName and spaceInviteToken are accepted.");
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  if (!displayName || displayName.length > maximumDisplayNameLength) throw new BrokerError(400, "Display name must be between 1 and 80 characters.");
  if (value.spaceInviteToken !== undefined && !isCapability(value.spaceInviteToken)) throw new BrokerError(400, "The Space invite is invalid.");
  return { displayName, ...(typeof value.spaceInviteToken === "string" ? { spaceInviteToken: value.spaceInviteToken } : {}) };
}

export function accessInput(value: unknown): AccessInput {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["currentMediaToken", "replaceMediaConnection"])) throw new BrokerError(400, "The access grant refresh request is invalid.");
  const replaceMediaConnection = value.replaceMediaConnection ?? false;
  if (typeof replaceMediaConnection !== "boolean") throw new BrokerError(400, "replaceMediaConnection must be a boolean.");
  if (value.currentMediaToken !== undefined && (typeof value.currentMediaToken !== "string" || value.currentMediaToken.length > maximumMediaTokenLength)) {
    throw new BrokerError(400, "currentMediaToken is invalid.");
  }
  return {
    replaceMediaConnection,
    ...(typeof value.currentMediaToken === "string" ? { currentMediaToken: value.currentMediaToken } : {}),
  };
}

export function participantCredentialInput(value: unknown): ParticipantCredentialInput {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["displayName", "participantCredentialId", "spaceInviteToken"])) throw new BrokerError(400, "Only displayName, participantCredentialId, and spaceInviteToken are accepted.");
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  if (!displayName || displayName.length > maximumDisplayNameLength) throw new BrokerError(400, "Display name must be between 1 and 80 characters.");
  if (value.spaceInviteToken !== undefined && !isCapability(value.spaceInviteToken)) throw new BrokerError(400, "The Space invite is invalid.");
  if (value.participantCredentialId !== undefined && !isCapability(value.participantCredentialId)) throw new BrokerError(400, "The Participant credential is invalid.");
  return {
    displayName,
    ...(typeof value.spaceInviteToken === "string" ? { spaceInviteToken: value.spaceInviteToken } : {}),
    ...(typeof value.participantCredentialId === "string" ? { participantCredentialId: value.participantCredentialId } : {}),
  };
}

export function accessGrantInput(value: unknown): AccessGrantInput {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["currentMediaToken", "participantCredentialId", "replaceMediaConnection", "spaceInviteToken"])) throw new BrokerError(400, "The access grant request is invalid.");
  if (!isCapability(value.spaceInviteToken) || !isCapability(value.participantCredentialId)) throw new BrokerError(401, "The Participant credential is missing or expired.");
  return { ...accessInput({ currentMediaToken: value.currentMediaToken, replaceMediaConnection: value.replaceMediaConnection }), spaceInviteToken: value.spaceInviteToken, participantCredentialId: value.participantCredentialId };
}

export function credentialInput(value: unknown): { readonly participantCredentialId: string; readonly spaceInviteToken: string } {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["participantCredentialId", "spaceInviteToken"])) throw new BrokerError(400, "The Participant credential request is invalid.");
  if (!isCapability(value.spaceInviteToken) || !isCapability(value.participantCredentialId)) throw new BrokerError(401, "The Participant credential is missing or expired.");
  return { spaceInviteToken: value.spaceInviteToken, participantCredentialId: value.participantCredentialId };
}

export function emptyInput(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length > 0) throw new BrokerError(400, "The cleanup request body must be empty.");
}

export function requireOrigin(request: Request, expectedOrigin: string): void {
  let configured: URL;
  try {
    configured = new URL(expectedOrigin);
  } catch {
    throw new BrokerError(503, "The Episode broker is not configured.");
  }
  if (configured.origin !== expectedOrigin || request.headers.get("origin") !== configured.origin) {
    throw new BrokerError(403, "The Episode broker only accepts requests from the Chalk web app.");
  }
}

export function requireTrustedCaller(request: Request, expectedOrigin: string): void {
  const origin = request.headers.get("origin");
  if (origin !== null) requireOrigin(request, expectedOrigin);
}

export function traceContext(request: Request): TraceContext {
  const incoming = request.headers.get("traceparent")?.toLowerCase();
  const traceparent = incoming && traceparentPattern.test(incoming) ? incoming : generatedTraceparent();
  const journey = normalizedJourney(request.headers.get("x-chalk-journey-id")) ?? crypto.randomUUID();
  const rootJourney = normalizedJourney(request.headers.get("x-chalk-root-journey-id")) ?? journey;
  const tracestate = normalizedTracestate(request.headers.get("tracestate"));
  return { journeyId: journey, rootJourneyId: rootJourney, traceparent, ...(tracestate ? { tracestate } : {}) };
}

export function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isCapability(value: unknown): value is string {
  return typeof value === "string" && capabilityPattern.test(value);
}

export function cookieValue(header: string | null): { readonly participantCredentialId: string; readonly spaceInviteToken: string } | undefined {
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== browserCredentialCookie) continue;
    const [spaceInviteToken, participantCredentialId, extra] = pair
      .slice(separator + 1)
      .trim()
      .split(".");
    if (extra !== undefined || !isCapability(spaceInviteToken) || !isCapability(participantCredentialId)) return undefined;
    return { spaceInviteToken, participantCredentialId };
  }
  return undefined;
}

export function json(status: number, body: unknown, headers?: Readonly<Record<string, string>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: privateHeaders({ "content-type": "application/json; charset=utf-8", ...headers }),
  });
}

export function empty(status: number, headers?: Readonly<Record<string, string>>): Response {
  return new Response(null, { status, headers: privateHeaders(headers) });
}

export function privateHeaders(input?: Readonly<Record<string, string>>): Headers {
  const headers = new Headers(input);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function generatedTraceparent(): string {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return `00-${traceId}-${spanId}-01`;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizedJourney(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(normalized)) return undefined;
  return normalized;
}

function normalizedTracestate(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 512 || /[\r\n]/u.test(normalized)) return undefined;
  return normalized;
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).some((key) => !names.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
