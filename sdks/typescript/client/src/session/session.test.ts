import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tabStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  } as Storage;
}

async function loadSession() {
  vi.resetModules();
  return import("./index");
}

describe("web session", () => {
  beforeEach(() => vi.stubGlobal("document", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps its ID across a reload in the same tab and gives a new tab its own", async () => {
    const tab = tabStorage();
    vi.stubGlobal("sessionStorage", tab);
    const first = (await loadSession()).currentSessionId();
    expect(first).toMatch(UUID);

    const afterReload = (await loadSession()).currentSessionId();
    expect(afterReload).toBe(first);

    vi.stubGlobal("sessionStorage", tabStorage());
    expect((await loadSession()).currentSessionId()).not.toBe(first);
  });

  it("replaces a stored value that is not a session ID", async () => {
    vi.stubGlobal("sessionStorage", tabStorage({ "chalk.session.id": "not-a-session" }));
    expect((await loadSession()).currentSessionId()).toMatch(UUID);
  });

  it("still has a session when storage is blocked", async () => {
    vi.stubGlobal("sessionStorage", undefined);
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const { currentSessionId } = await loadSession();
    expect(currentSessionId()).toMatch(UUID);
    expect(currentSessionId()).toBe(currentSessionId());
  });

  it("sends baggage and a trace context on each request without overriding the caller's headers", async () => {
    vi.stubGlobal("sessionStorage", tabStorage());
    const { currentSessionId, withRequestContext } = await loadSession();
    const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));

    await withRequestContext(send)("https://api.example.test/v1/ping", { headers: { Authorization: "Bearer t" } });
    await withRequestContext(send)("https://api.example.test/v1/ping", { headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" } });

    const [first, second] = send.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(first?.get("baggage")).toBe(`session.id=${currentSessionId()}`);
    expect(first?.get("authorization")).toBe("Bearer t");
    expect(first?.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(second?.get("traceparent")).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });

  it("uses a different trace for each request", async () => {
    vi.stubGlobal("sessionStorage", tabStorage());
    const { requestContextHeaders } = await loadSession();
    expect(requestContextHeaders().traceparent).not.toBe(requestContextHeaders().traceparent);
  });
});

describe("without an app session", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds nothing on a server and leaves the request untouched", async () => {
    const { currentSessionId, withRequestContext, sessionBaggage } = await loadSession();
    const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null));
    await withRequestContext(send)("https://api.example.test/v1/ping", { headers: { Authorization: "Bearer t" } });
    expect(currentSessionId()).toBeUndefined();
    expect(sessionBaggage()).toBeUndefined();
    expect(send.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: "Bearer t" });
  });

  it("uses the platform's own source once installed", async () => {
    const { currentSessionId, setSessionSource, requestContextHeaders } = await loadSession();
    setSessionSource(() => "3f2b8c1e-9d4a-4b7e-8c55-0a1d2e3f4a5b");
    expect(currentSessionId()).toBe("3f2b8c1e-9d4a-4b7e-8c55-0a1d2e3f4a5b");
    expect(requestContextHeaders().baggage).toBe("session.id=3f2b8c1e-9d4a-4b7e-8c55-0a1d2e3f4a5b");
  });
});
