import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebTokenProvider, fetchWebAccessToken, getAccessTokenExpiryMs, getChalkSessionCacheKey, getJoinContext, getOrCreateLocalClientId, resolveApiUrl, setJoinContext, shouldPrimeTokenCache, shouldUseRoomScopedTokenProvider } from "./webMeeting";

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
    expect(resolveApiUrl("https://chalk-api.q9labs.ai", "chalkmeet.com")).toBe("https://chalk-api.q9labs.ai");
  });

  it("ignores a localhost build-time api url on hosted origins", () => {
    expect(resolveApiUrl("http://localhost:8080", "chalkmeet.com")).toBe("https://chalk-api.q9labs.ai");
  });
});

describe("fetchWebAccessToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreBrowserEnv();
  });

  it("sends a stable bootstrap header on localhost", async () => {
    installBrowserEnv("http://localhost:3070/room/abc");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "token-123" }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const first = await fetchWebAccessToken("http://localhost:8080");
    const second = await fetchWebAccessToken("http://localhost:8080");

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

  it("sends a stable bootstrap header on hosted origins too", async () => {
    installBrowserEnv("https://chalkmeet.com/room/abc");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "token-123" }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const first = await fetchWebAccessToken("https://chalk-api.q9labs.ai");
    const second = await fetchWebAccessToken("https://chalk-api.q9labs.ai");

    expect(first).toBe("token-123");
    expect(second).toBe("token-123");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://chalk-api.q9labs.ai/api/v1/internal/auth/access-token",
      expect.objectContaining({
        headers: {
          "X-Chalk-Local-Client-ID": expect.any(String),
        },
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(fetchMock.mock.calls[1]?.[1]);
  });
});

describe("getAccessTokenExpiryMs", () => {
  it("reads exp from a jwt payload", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
    expect(getAccessTokenExpiryMs(`header.${payload}.sig`)).toBe(1_700_000_000_000);
  });

  it("returns null for malformed tokens", () => {
    expect(getAccessTokenExpiryMs("not-a-jwt")).toBeNull();
  });
});

describe("getJoinContext", () => {
  afterEach(() => {
    restoreBrowserEnv();
  });

  it("returns room token context on the matching room route", () => {
    installBrowserEnv("http://localhost:3070/room/2f0b302b-2449-43f5-ae3b-de57decb9f09");
    setJoinContext({
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "math-101",
      accessToken: "access-123",
      expiresAtMs: 1_700_000_900_000,
    });

    expect(getJoinContext()).toEqual({
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "math-101",
      accessToken: "access-123",
      expiresAtMs: 1_700_000_900_000,
    });
  });

  it("returns room-scoped join context on the matching room route", () => {
    installBrowserEnv("http://localhost:3070/room/2f0b302b-2449-43f5-ae3b-de57decb9f09");
    setJoinContext({
      joinToken: "join-token",
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "math-101",
    });

    expect(getJoinContext()).toEqual({
      joinToken: "join-token",
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "math-101",
    });
  });

  it("ignores stale join context on a different room route", () => {
    installBrowserEnv("http://localhost:3070/room/36b56444-2449-43f5-ae3b-de57decb9f09");
    setJoinContext({
      joinToken: "join-token",
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      roomName: "math-101",
    });

    expect(getJoinContext()).toBeNull();
  });
});

describe("shouldPrimeTokenCache", () => {
  it("skips eager token warmup on join-link routes", () => {
    expect(shouldPrimeTokenCache("/j/join-token-123")).toBe(false);
  });

  it("allows eager token warmup on room routes", () => {
    expect(shouldPrimeTokenCache("/room/2f0b302b-2449-43f5-ae3b-de57decb9f09")).toBe(true);
  });
});

describe("shouldUseRoomScopedTokenProvider", () => {
  it("uses room-scoped token providers on room routes", () => {
    expect(shouldUseRoomScopedTokenProvider("/room/2f0b302b-2449-43f5-ae3b-de57decb9f09")).toBe(true);
  });

  it("uses room-scoped token providers on join-link routes", () => {
    expect(shouldUseRoomScopedTokenProvider("/j/join-token-123")).toBe(true);
  });
});

describe("getChalkSessionCacheKey", () => {
  it("isolates room session state from the generic app cache", () => {
    expect(getChalkSessionCacheKey("/room/abc", "")).toBe('room:/room/abc:""');
  });

  it("keeps join route session state keyed by path", () => {
    expect(getChalkSessionCacheKey("/j/join-token-123", "")).toBe("join:/j/join-token-123");
  });
});

describe("createWebTokenProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreBrowserEnv();
  });

  it("reuses a fresh room token for the current room", async () => {
    installBrowserEnv("https://chalkmeet.com/room/2f0b302b-2449-43f5-ae3b-de57decb9f09");
    setJoinContext({
      roomId: "2f0b302b-2449-43f5-ae3b-de57decb9f09",
      accessToken: "access-123",
      expiresAtMs: Date.now() + 60_000,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const tokenProvider = createWebTokenProvider("https://chalk-api.q9labs.ai");

    await expect(tokenProvider()).resolves.toBe("access-123");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getOrCreateLocalClientId", () => {
  afterEach(() => {
    restoreBrowserEnv();
  });

  it("keeps a stable client id on localhost", () => {
    installBrowserEnv("http://localhost:3070/room/abc");

    const first = getOrCreateLocalClientId();
    const second = getOrCreateLocalClientId();

    expect(first).toBeTruthy();
    expect(first).toBe(second);
  });

  it("keeps a stable client id on hosted origins", () => {
    installBrowserEnv("https://chalkmeet.com/room/abc");
    const first = getOrCreateLocalClientId();
    const second = getOrCreateLocalClientId();
    expect(first).toBeTruthy();
    expect(first).toBe(second);
  });
});
