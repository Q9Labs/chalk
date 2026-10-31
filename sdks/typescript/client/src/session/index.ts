/**
 * The session is one run of a Chalk app on one device: a browser tab, or an app launch on mobile. Its ID is the
 * OpenTelemetry attribute `session.id` and travels with the trace context as W3C baggage on every Chalk API request and
 * Sync connection. It is unrelated to an Episode and to Cloudflare track or dashboard login `sessionId`s.
 */
export const SESSION_ID_KEY = "session.id";
const STORAGE_KEY = "chalk.session.id";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SessionSource = () => string | undefined;

let source: SessionSource = browserSession;
let browserId: string | undefined;

/** Platforms with their own session rules, such as React Native, install their source once at startup. */
export function setSessionSource(next: SessionSource): void {
  source = next;
}

/** The current session ID, or undefined where no app session exists, such as a Node server. */
export function currentSessionId(): string | undefined {
  return source();
}

export function newSessionId(): string {
  const random = globalThis.crypto;
  if (typeof random?.randomUUID === "function") return random.randomUUID();
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A tab keeps its ID across reloads through sessionStorage; each new tab gets its own. */
function browserSession(): string | undefined {
  if (browserId) return browserId;
  if (typeof globalThis.document === "undefined") return undefined;
  let storage: Storage | undefined;
  try {
    storage = globalThis.sessionStorage;
  } catch {
    /* Blocked storage keeps the ID for this page load only. */
  }
  const stored = storage?.getItem(STORAGE_KEY) ?? undefined;
  browserId = stored && SESSION_ID.test(stored) ? stored : newSessionId();
  try {
    if (browserId !== stored) storage?.setItem(STORAGE_KEY, browserId);
  } catch {
    /* A full or blocked store is not a request failure. */
  }
  return browserId;
}

/** The W3C baggage value that carries the session, or undefined where no app session exists. */
export function sessionBaggage(): string | undefined {
  const sessionId = currentSessionId();
  return sessionId ? `${SESSION_ID_KEY}=${sessionId}` : undefined;
}

/** `baggage` and a fresh `traceparent` for one Chalk API request; empty where there is no app session. */
export function requestContextHeaders(): Record<string, string> {
  const baggage = sessionBaggage();
  if (!baggage) return {};
  return { baggage, traceparent: `00-${newSessionId().replaceAll("-", "")}-${newSessionId().replaceAll("-", "").slice(0, 16)}-01` };
}

/** Wraps a fetch so every request carries the session; headers the caller already set win. Use only for Chalk API origins. */
export function withRequestContext(fetchImplementation?: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const send = fetchImplementation ?? globalThis.fetch;
    const context = requestContextHeaders();
    if (Object.keys(context).length === 0) return send(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(context)) if (!headers.has(name)) headers.set(name, value);
    return send(input, { ...init, headers });
  };
}
