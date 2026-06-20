import { chalkDebugCollector } from "@q9labs/chalk-core";

let installed = false;

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

const normalizeHeaders = (headers: Headers) => Object.fromEntries([...headers.entries()].map(([key, value]) => [key, value]));

const parseTextBody = (text: string, contentType: string | null) => {
  if (!text) {
    return null;
  }

  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
};

const readRequestBody = async (request: Pick<Request, "text" | "headers">) => {
  try {
    const text = await request.text();
    return parseTextBody(text, request.headers.get("content-type"));
  } catch {
    return null;
  }
};

const readResponseBody = async (response: Response) => {
  try {
    const text = await response.text();
    return parseTextBody(text, response.headers.get("content-type"));
  } catch {
    return null;
  }
};

const installConsoleCapture = () => {
  const levels = Object.keys(originalConsole) as Array<keyof typeof originalConsole>;

  for (const level of levels) {
    console[level] = ((...args: unknown[]) => {
      chalkDebugCollector.recordConsole({
        id: chalkDebugCollector.nextId(),
        timestamp: new Date().toISOString(),
        level,
        args,
      });
      originalConsole[level](...args);
    }) as (typeof console)[typeof level];
  }
};

const installRuntimeErrorCapture = () => {
  window.addEventListener("error", (event) => {
    chalkDebugCollector.recordRuntimeError({
      id: chalkDebugCollector.nextId(),
      timestamp: new Date().toISOString(),
      type: "error",
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      reason: event.error,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    chalkDebugCollector.recordRuntimeError({
      id: chalkDebugCollector.nextId(),
      timestamp: new Date().toISOString(),
      type: "unhandledrejection",
      message: reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Unhandled rejection",
      stack: reason instanceof Error ? reason.stack : undefined,
      reason,
    });
  });
};

const installFetchCapture = () => {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const requestBody = await readRequestBody(request.clone());
    const startedAt = performance.now();

    try {
      const response = await originalFetch(request);
      const responseBody = await readResponseBody(response.clone());
      chalkDebugCollector.recordFetch({
        id: chalkDebugCollector.nextId(),
        timestamp: new Date().toISOString(),
        method: request.method,
        url: request.url,
        requestHeaders: normalizeHeaders(request.headers),
        requestBody,
        credentials: request.credentials,
        mode: request.mode,
        destination: request.destination,
        referrer: request.referrer,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        redirected: response.redirected,
        durationMs: Math.round(performance.now() - startedAt),
        responseHeaders: normalizeHeaders(response.headers),
        responseBody,
      });
      return response;
    } catch (error) {
      chalkDebugCollector.recordFetch({
        id: chalkDebugCollector.nextId(),
        timestamp: new Date().toISOString(),
        method: request.method,
        url: request.url,
        requestHeaders: normalizeHeaders(request.headers),
        requestBody,
        credentials: request.credentials,
        mode: request.mode,
        destination: request.destination,
        referrer: request.referrer,
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }) as typeof window.fetch;
};

const installWebSocketCapture = () => {
  const OriginalWebSocket = window.WebSocket;

  function DebugWebSocket(this: WebSocket, url: string | URL, protocols?: string | string[]) {
    const socket = new OriginalWebSocket(url, protocols);
    const socketUrl = typeof url === "string" ? url : url.toString();
    const protocolList = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];

    chalkDebugCollector.recordWebSocket({
      id: chalkDebugCollector.nextId(),
      timestamp: new Date().toISOString(),
      url: socketUrl,
      event: "construct",
      protocols: protocolList,
      readyState: socket.readyState,
    });

    const originalSend = socket.send.bind(socket);
    socket.send = ((payload: Parameters<WebSocket["send"]>[0]) => {
      chalkDebugCollector.recordWebSocket({
        id: chalkDebugCollector.nextId(),
        timestamp: new Date().toISOString(),
        url: socketUrl,
        event: "send",
        readyState: socket.readyState,
        payload,
      });
      originalSend(payload);
    }) as typeof socket.send;

    socket.addEventListener("open", () => {
      chalkDebugCollector.recordWebSocket({
        id: chalkDebugCollector.nextId(),
        timestamp: new Date().toISOString(),
        url: socketUrl,
        event: "open",
        readyState: socket.readyState,
      });
    });

    socket.addEventListener("message", (event) => {
      chalkDebugCollector.recordWebSocket({
        id: chalkDebugCollector.nextId(),
        timestamp: new Date().toISOString(),
        url: socketUrl,
        event: "message",
        readyState: socket.readyState,
        payload: event.data,
      });
    });

    socket.addEventListener("close", (event) => {
      chalkDebugCollector.recordWebSocket({
        id: chalkDebugCollector.nextId(),
        timestamp: new Date().toISOString(),
        url: socketUrl,
        event: "close",
        readyState: socket.readyState,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    });

    socket.addEventListener("error", () => {
      chalkDebugCollector.recordWebSocket({
        id: chalkDebugCollector.nextId(),
        timestamp: new Date().toISOString(),
        url: socketUrl,
        event: "error",
        readyState: socket.readyState,
        error: "WebSocket error event",
      });
    });

    return socket;
  }

  DebugWebSocket.prototype = OriginalWebSocket.prototype;
  Object.defineProperties(DebugWebSocket, {
    CONNECTING: { value: OriginalWebSocket.CONNECTING },
    OPEN: { value: OriginalWebSocket.OPEN },
    CLOSING: { value: OriginalWebSocket.CLOSING },
    CLOSED: { value: OriginalWebSocket.CLOSED },
  });

  window.WebSocket = DebugWebSocket as unknown as typeof WebSocket;
};

export function installChalkBrowserDebugRuntime() {
  if (installed || typeof window === "undefined") {
    return;
  }

  installed = true;
  installConsoleCapture();
  installRuntimeErrorCapture();
  installFetchCapture();
  installWebSocketCapture();
}

export function registerDebugSection(name: string, provider: () => unknown) {
  return chalkDebugCollector.registerSection(name, provider);
}
