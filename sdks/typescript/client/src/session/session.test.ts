import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tabStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    entries: () => [...values],
  } as Storage;
}

const entriesOf = (storage: Storage): Record<string, string> => Object.fromEntries((storage as Storage & { entries: () => [string, string][] }).entries());

/** A page load in a tab: the tab's storage and its `window`, whose name survives reloads. */
function loadIn(tab: { readonly storage: Storage; readonly window: { name: string } }) {
  vi.stubGlobal("sessionStorage", tab.storage);
  vi.stubGlobal("window", tab.window);
  return loadSession();
}

async function loadSession() {
  vi.resetModules();
  return import("./index");
}

describe("web session", () => {
  beforeEach(() => vi.stubGlobal("document", {}));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps its ID across a reload in the same tab and gives a new tab its own", async () => {
    const tab = { storage: tabStorage(), window: { name: "" } };
    const first = (await loadIn(tab)).currentSessionId();
    expect(first).toMatch(UUID);

    const afterReload = (await loadIn(tab)).currentSessionId();
    expect(afterReload).toBe(first);

    expect((await loadIn({ storage: tabStorage(), window: { name: "" } })).currentSessionId()).not.toBe(first);
  });

  it("gives a duplicated tab its own ID although it inherits a copy of sessionStorage", async () => {
    const original = { storage: tabStorage(), window: { name: "" } };
    const first = (await loadIn(original)).currentSessionId();

    // Chrome's "Duplicate tab" copies sessionStorage and leaves window.name empty.
    const duplicate = { storage: tabStorage(entriesOf(original.storage)), window: { name: "" } };
    const duplicateId = (await loadIn(duplicate)).currentSessionId();
    expect(duplicateId).toMatch(UUID);
    expect(duplicateId).not.toBe(first);

    expect((await loadIn(duplicate)).currentSessionId()).toBe(duplicateId);
    expect((await loadIn(original)).currentSessionId()).toBe(first);
  });

  it("leaves a window.name the app owns alone and keeps the stored ID", async () => {
    const tab = { storage: tabStorage(), window: { name: "checkout-frame" } };
    const first = (await loadIn(tab)).currentSessionId();
    expect((await loadIn(tab)).currentSessionId()).toBe(first);
    expect(tab.window.name).toBe("checkout-frame");
  });

  it("replaces a stored value that is not a session ID", async () => {
    expect((await loadIn({ storage: tabStorage({ "chalk.session.id": "not-a-session" }), window: { name: "" } })).currentSessionId()).toMatch(UUID);
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
