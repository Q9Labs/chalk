import type { NativeSessionTelemetry } from "../telemetry";

export interface NativeTransportCorrelationConfig {
  readonly apiUrl: string;
  readonly credentials?: readonly string[];
  readonly dynamicCredentials?: ReadonlySet<string>;
  readonly telemetry: NativeSessionTelemetry;
  readonly wsUrl?: string;
}

export interface TrackedNativeTokenProvider {
  readonly credentials: ReadonlySet<string>;
  readonly provider?: () => Promise<string>;
}

interface TransportRegistration extends NativeTransportCorrelationConfig {
  readonly apiTarget: URL;
  readonly wsTarget?: URL;
}

type NativeFetch = typeof globalThis.fetch;
type NativeWebSocketConstructor = typeof globalThis.WebSocket;

/** Records credentials returned by a token provider so concurrent transports can retain exact journey ownership. */
export function trackNativeTokenProvider(provider: (() => Promise<string>) | undefined): TrackedNativeTokenProvider {
  const credentials = new Set<string>();
  if (!provider) return { credentials };

  return {
    credentials,
    provider: async () => {
      const credential = await provider();
      credentials.add(credential);
      while (credentials.size > 2) {
        const oldest = credentials.values().next();
        if (oldest.done) break;
        credentials.delete(oldest.value);
      }
      return credential;
    },
  };
}

const registrations: TransportRegistration[] = [];
let originalFetch: NativeFetch | undefined;
let originalWebSocket: NativeWebSocketConstructor | undefined;
let correlatedFetch: NativeFetch | undefined;
let correlatedWebSocket: NativeWebSocketConstructor | undefined;

/** Applies one journey context to matching native HTTP requests and sync WebSocket traffic. */
export function correlateNativeTransports(config: NativeTransportCorrelationConfig): () => void {
  const registration: TransportRegistration = {
    ...config,
    apiTarget: new URL(config.apiUrl),
    ...(config.wsUrl ? { wsTarget: new URL(config.wsUrl) } : {}),
  };
  registrations.push(registration);
  installFetchCorrelation();
  installWebSocketCorrelation();

  return () => {
    const index = registrations.indexOf(registration);
    if (index >= 0) registrations.splice(index, 1);
    if (registrations.length === 0) restoreNativeTransports();
  };
}

function installFetchCorrelation(): void {
  if (correlatedFetch || typeof globalThis.fetch !== "function") return;

  const nativeFetch = globalThis.fetch;
  originalFetch = nativeFetch;
  correlatedFetch = (async (input, init) => {
    const headers = requestHeaders(input, init);
    const registration = findRegistration(requestUrl(input), "apiTarget", headers);
    if (!registration) return nativeFetch(input, init);

    for (const [name, value] of Object.entries(registration.telemetry.apiHeaders)) headers.set(name, value);
    return nativeFetch(input, { ...init, headers });
  }) as NativeFetch;
  globalThis.fetch = correlatedFetch;
}

function installWebSocketCorrelation(): void {
  if (correlatedWebSocket || typeof globalThis.WebSocket !== "function" || !registrations.some((entry) => entry.wsTarget)) return;

  originalWebSocket = globalThis.WebSocket;
  correlatedWebSocket = new Proxy(originalWebSocket, {
    construct(target, argumentsList, newTarget) {
      const registration = findRegistration(String(argumentsList[0]), "wsTarget", webSocketHeaders(argumentsList));
      if (!registration) return Reflect.construct(target, argumentsList, newTarget);

      const correlatedArguments = withWebSocketHeaders(argumentsList, registration.telemetry.apiHeaders);
      const socket = Reflect.construct(target, correlatedArguments, newTarget) as WebSocket;
      return correlateWebSocketFrames(socket, registration.telemetry.syncCorrelation);
    },
  });
  globalThis.WebSocket = correlatedWebSocket;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(typeof input === "object" && "headers" in input ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return headers;
}

function findRegistration(url: string, targetKey: "apiTarget" | "wsTarget", headers: Headers): TransportRegistration | undefined {
  let requestTarget: URL;
  try {
    requestTarget = new URL(url);
  } catch {
    return undefined;
  }

  const candidates = registrations.filter((registration) => {
    const target = registration[targetKey];
    return target ? sameUrlScope(requestTarget, target) : false;
  });
  if (candidates.length <= 1) return candidates[0];

  const journeyId = headers.get("x-chalk-journey-id");
  if (journeyId) {
    return uniqueMatch(candidates, (registration) => registration.telemetry.context.journeyId === journeyId);
  }

  const requestCredentials = transportCredentials(requestTarget, headers);
  if (requestCredentials.length > 0) {
    return uniqueMatch(candidates, (registration) => registrationCredentials(registration).some((credential) => requestCredentials.includes(credential)));
  }

  // The initiating session is unknowable when same-scope transports carry no
  // identity. Leaving them unmodified avoids corrupting multiple journeys.
  return undefined;
}

function registrationCredentials(registration: TransportRegistration): string[] {
  return [...(registration.credentials ?? []), ...(registration.dynamicCredentials ?? [])];
}

function uniqueMatch(candidates: readonly TransportRegistration[], predicate: (registration: TransportRegistration) => boolean): TransportRegistration | undefined {
  const matches = candidates.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function transportCredentials(url: URL, headers: Headers): string[] {
  const authorization = headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return [bearer, headers.get("x-api-key"), url.searchParams.get("authToken"), url.searchParams.get("token")].filter((value): value is string => Boolean(value));
}

function sameUrlScope(request: URL, target: URL): boolean {
  const targetPath = target.pathname.replace(/\/$/, "");
  return request.origin === target.origin && (request.pathname === targetPath || request.pathname.startsWith(`${targetPath}/`));
}

function withWebSocketHeaders(argumentsList: unknown[], correlationHeaders: Readonly<Record<string, string>>): unknown[] {
  const options = isRecord(argumentsList[2]) ? argumentsList[2] : {};
  const headers = new Headers(isRecord(options.headers) ? (options.headers as Record<string, string>) : undefined);
  for (const [name, value] of Object.entries(correlationHeaders)) headers.set(name, value);
  const nextArguments = [...argumentsList];
  nextArguments[2] = { ...options, headers: Object.fromEntries(headers.entries()) };
  return nextArguments;
}

function webSocketHeaders(argumentsList: unknown[]): Headers {
  const options = isRecord(argumentsList[2]) ? argumentsList[2] : undefined;
  return new Headers(options && isRecord(options.headers) ? (options.headers as Record<string, string>) : undefined);
}

function correlateWebSocketFrames(socket: WebSocket, correlation: NativeSessionTelemetry["syncCorrelation"]): WebSocket {
  const send = socket.send.bind(socket);
  socket.send = (data) => send(correlatedFrame(data, correlation));
  return socket;
}

function correlatedFrame(data: string | ArrayBufferLike | Blob | ArrayBufferView, correlation: NativeSessionTelemetry["syncCorrelation"]): string | ArrayBufferLike | Blob | ArrayBufferView {
  if (typeof data !== "string") return data;

  try {
    const frame: unknown = JSON.parse(data);
    return isRecord(frame) ? JSON.stringify({ ...frame, ...correlation }) : data;
  } catch {
    return data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreNativeTransports(): void {
  if (originalFetch && globalThis.fetch === correlatedFetch) globalThis.fetch = originalFetch;
  if (originalWebSocket && globalThis.WebSocket === correlatedWebSocket) globalThis.WebSocket = originalWebSocket;
  originalFetch = undefined;
  originalWebSocket = undefined;
  correlatedFetch = undefined;
  correlatedWebSocket = undefined;
}
