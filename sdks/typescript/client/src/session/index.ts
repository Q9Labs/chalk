/**
 * The session is one run of a Chalk app on one device: a browser tab, or an app launch on mobile. Its ID is the
 * OpenTelemetry attribute `session.id` and travels with the trace context as W3C baggage on every Chalk API request and
 * Sync connection. It is unrelated to an Episode and to Cloudflare track or dashboard login `sessionId`s.
 */
export const SESSION_ID_KEY = "session.id";
const STORAGE_KEY = "chalk.session.id";
const TAB_KEY = "chalk.session.tab";
const TAB_NAME_PREFIX = "chalk.tab:";
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
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (digit) => (Number(digit) ^ (random.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(digit) / 4)))).toString(16));
}

/**
 * A tab keeps its ID across reloads through sessionStorage; each new tab gets its own. A duplicated tab and a tab opened
 * by a link with an opener inherit a copy of sessionStorage but not `window.name`, so the stored ID counts only while the
 * tab's `window.name` token matches the one stored beside it.
 */
function browserSession(): string | undefined {
  if (browserId) return browserId;
  if (typeof globalThis.document === "undefined") return undefined;
  const tab = currentTabId();
  browserId = newSessionId();
  try {
    const storage = globalThis.sessionStorage;
    browserId = storedSession(storage, tab) ?? browserId;
    storage.setItem(STORAGE_KEY, browserId);
    if (tab !== undefined) storage.setItem(TAB_KEY, tab);
  } catch {
    /* Blocked or full storage keeps the ID in memory for this page load; a session must never break a request. */
  }
  return browserId;
}

/** The stored ID, when it is a session ID and was stored by this tab. */
function storedSession(storage: Storage, tab: string | undefined): string | undefined {
  const stored = storage.getItem(STORAGE_KEY) ?? undefined;
  if (!stored || !SESSION_ID.test(stored)) return undefined;
  return tab === undefined || storage.getItem(TAB_KEY) === tab ? stored : undefined;
}

/** The token that names this tab in `window.name`, which survives reloads but is empty in a duplicated tab. Undefined when the app owns `window.name`. */
export function currentTabId(): string | undefined {
  const win = globalThis.window;
  if (!win) return undefined;
  if (win.name.startsWith(TAB_NAME_PREFIX)) return win.name;
  if (win.name !== "") return undefined;
  win.name = `${TAB_NAME_PREFIX}${newSessionId()}`;
  return win.name;
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
  const trace = newSessionId().replaceAll("-", "");
  return { baggage, traceparent: `00-${trace}-${trace.slice(16)}-01` };
}

const JOURNEY_HEADER = "x-chalk-journey-id";

export type FailedRequest = { readonly journeyId: string; readonly status: number };
let failedRequest: FailedRequest | undefined;

/**
 * The API names every request with a journey ID in the `x-chalk-journey-id` response header and puts it on that
 * request's log line. The client keeps the latest failure's ID so a problem report can quote the request that failed. The
 * client never sends a journey ID: the ledger keys one lifecycle by it, so a session-wide ID would merge unrelated ones.
 */
export function lastFailedRequest(): FailedRequest | undefined {
  return failedRequest;
}

function recordFailure(response: Response): Response {
  const journeyId = response.headers.get(JOURNEY_HEADER);
  if (!response.ok && journeyId && SESSION_ID.test(journeyId)) failedRequest = { journeyId, status: response.status };
  return response;
}

/** Wraps a fetch so every request carries the session and failed responses keep their journey ID; headers the caller already set win. Use only for Chalk API origins. */
export function withRequestContext(fetchImplementation?: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const send = fetchImplementation ?? globalThis.fetch;
    const context = requestContextHeaders();
    if (Object.keys(context).length === 0) return recordFailure(await send(input, init));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(context)) if (!headers.has(name)) headers.set(name, value);
    return recordFailure(await send(input, { ...init, headers }));
  };
}
