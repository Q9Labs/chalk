import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInternalAccessToken, getJoinContext, getOrCreateLocalClientId, resolveApiUrl, setJoinContext, startMagicLink, verifyMagicLink } from "./internalAuth";

const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;
const originalSessionStorage = globalThis.sessionStorage;

function createStorageMock() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };
}

function installBrowserEnv(rawUrl: string) {
  let currentUrl = new URL(rawUrl);
  const localStorage = createStorageMock();
  const sessionStorage = createStorageMock();
  const windowMock = {
    get location() {
      return currentUrl;
    },
    history: {
      replaceState: (_state: unknown, _title: string, nextUrl: string) => {
        currentUrl = new URL(nextUrl);
      },
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: sessionStorage,
    writable: true,
  });
  return { window: windowMock, localStorage, sessionStorage };
}

function restoreBrowserEnv() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: originalLocalStorage,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: originalSessionStorage,
    writable: true,
  });
}

describe("resolveApiUrl", () => {
  it("prefers localhost api when localhost is running with prod config", () => {
    expect(resolveApiUrl("https://chalk-api.q9labs.ai", "localhost")).toBe("http://localhost:8080");
  });

  it("prefers localhost api when localhost has no explicit api url", () => {
    expect(resolveApiUrl(undefined, "127.0.0.1")).toBe("http://localhost:8080");
  });

  it("keeps explicit local overrides", () => {
    expect(resolveApiUrl("http://localhost:9090", "localhost")).toBe("http://localhost:9090");
  });

  it("overrides any remote api host on localhost", () => {
    expect(resolveApiUrl("https://staging-api.q9labs.ai", "localhost")).toBe("http://localhost:8080");
  });

  it("keeps prod api on hosted origins", () => {
    expect(resolveApiUrl("https://chalk-api.q9labs.ai", "chalk.q9labs.ai")).toBe("https://chalk-api.q9labs.ai");
  });
});

describe("verifyMagicLink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dedupes concurrent verification requests for the same token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await Promise.all([verifyMagicLink("https://chalk-api.q9labs.ai", "token-123"), verifyMagicLink("https://chalk-api.q9labs.ai", "token-123")]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed verification attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "invalid or expired token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(verifyMagicLink("https://chalk-api.q9labs.ai", "token-456")).rejects.toThrow("invalid or expired token");

    await expect(verifyMagicLink("https://chalk-api.q9labs.ai", "token-456")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchInternalAccessToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreBrowserEnv();
  });

  it("sends a stable localhost bootstrap header", async () => {
    installBrowserEnv("http://localhost:3070/dashboard");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "token-123" }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const first = await fetchInternalAccessToken("http://localhost:8080");
    const second = await fetchInternalAccessToken("http://localhost:8080");

    expect(first).toBe("token-123");
    expect(second).toBe("token-123");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8080/api/v1/internal/auth/access-token",
      expect.objectContaining({
        headers: {
          "X-Chalk-Local-Client-ID": expect.any(String),
        },
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(fetchMock.mock.calls[1]?.[1]);
  });

  it("does not send localhost bootstrap header on hosted origins", async () => {
    installBrowserEnv("https://chalk.q9labs.ai/dashboard");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "token-123" }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await fetchInternalAccessToken("https://chalk-api.q9labs.ai");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chalk-api.q9labs.ai/api/v1/internal/auth/access-token",
      expect.objectContaining({
        headers: undefined,
      }),
    );
  });
});

describe("getJoinContext", () => {
  afterEach(() => {
    restoreBrowserEnv();
  });

  it("returns room-scoped join context on the matching room route", () => {
    installBrowserEnv("http://localhost:3070/room/math-101");
    setJoinContext({
      joinToken: "join-token",
      roomName: "math-101",
    });

    expect(getJoinContext()).toEqual({
      joinToken: "join-token",
      roomName: "math-101",
    });
  });

  it("ignores stale join context on a different room route", () => {
    installBrowserEnv("http://localhost:3070/room/physics-201");
    setJoinContext({
      joinToken: "join-token",
      roomName: "math-101",
    });

    expect(getJoinContext()).toBeNull();
  });
});

describe("startMagicLink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreBrowserEnv();
  });

  it("requests dashboard as the default callback url", async () => {
    installBrowserEnv("http://localhost:3000/dashboard");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await startMagicLink("https://chalk-api.q9labs.ai", "hasan@q9labs.ai");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chalk-api.q9labs.ai/api/v1/internal/auth/start",
      expect.objectContaining({
        body: JSON.stringify({
          email: "hasan@q9labs.ai",
          callback_url: "http://localhost:3000/dashboard",
        }),
      }),
    );
  });
});

describe("getOrCreateLocalClientId", () => {
  afterEach(() => {
    restoreBrowserEnv();
  });

  it("reuses the same id across calls on localhost", () => {
    installBrowserEnv("http://localhost:3070/");

    const first = getOrCreateLocalClientId();
    const second = getOrCreateLocalClientId();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });
});
