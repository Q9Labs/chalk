import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredChalkTokens,
  createWebTokenProvider,
  createRoomJoinLink,
  fetchInternalAccessToken,
  fetchInternalSession,
  getAccessTokenExpiryMs,
  getChalkSessionCacheKey,
  getJoinContext,
  getOrCreateLocalClientId,
  logoutInternalSession,
  resolveApiUrl,
  setJoinContext,
  shouldPrimeTokenCache,
  shouldUseInternalRoomAuth,
  shouldUseRoomScopedTokenProvider,
  signInWithGoogleCode,
} from "./internalAuth";

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
    expect(resolveApiUrl("https://chalk-api.q9labs.ai", "localhost")).toBe(
      "http://localhost:8080",
    );
  });

  it("prefers localhost api when localhost has no explicit api url", () => {
    expect(resolveApiUrl(undefined, "127.0.0.1")).toBe("http://localhost:8080");
  });

  it("keeps explicit local overrides", () => {
    expect(resolveApiUrl("http://localhost:9090", "localhost")).toBe(
      "http://localhost:9090",
    );
  });

  it("overrides any remote api host on localhost", () => {
    expect(resolveApiUrl("https://staging-api.q9labs.ai", "localhost")).toBe(
      "http://localhost:8080",
    );
  });

  it("keeps prod api on hosted origins", () => {
    expect(
      resolveApiUrl("https://chalk-api.q9labs.ai", "chalkmeet.com"),
    ).toBe("https://chalk-api.q9labs.ai");
  });
});

describe("fetchInternalAccessToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreBrowserEnv();
  });

  it("sends a stable bootstrap header on localhost", async () => {
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

  it("sends a stable bootstrap header on hosted origins too", async () => {
    installBrowserEnv("https://chalkmeet.com/dashboard");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "token-123" }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    const first = await fetchInternalAccessToken("https://chalk-api.q9labs.ai");
    const second = await fetchInternalAccessToken("https://chalk-api.q9labs.ai");

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
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString(
      "base64url",
    );
    expect(getAccessTokenExpiryMs(`header.${payload}.sig`)).toBe(
      1_700_000_000_000,
    );
  });

  it("returns null for malformed tokens", () => {
    expect(getAccessTokenExpiryMs("not-a-jwt")).toBeNull();
  });
});

describe("internal session helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for an unauthenticated session lookup", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    await expect(
      fetchInternalSession("https://chalk-api.q9labs.ai"),
    ).resolves.toBeNull();
  });

  it("posts the google auth code for sign-in", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, user: { email: "hasan@q9labs.ai" } }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      signInWithGoogleCode("https://chalk-api.q9labs.ai", "oauth-code"),
    ).resolves.toEqual({ ok: true, user: { email: "hasan@q9labs.ai" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chalk-api.q9labs.ai/api/v1/internal/auth/google",
      expect.objectContaining({
        body: JSON.stringify({ code: "oauth-code" }),
        credentials: "include",
        method: "POST",
        headers: expect.objectContaining({
          "X-Requested-With": "XMLHttpRequest",
        }),
      }),
    );
  });

  it("posts logout with credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await logoutInternalSession("https://chalk-api.q9labs.ai");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chalk-api.q9labs.ai/api/v1/internal/auth/logout",
      expect.objectContaining({
        credentials: "include",
        method: "POST",
      }),
    );
  });
});

describe("createRoomJoinLink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreBrowserEnv();
  });

  it("defaults hosted share links to the canonical chalkmeet origin", async () => {
    installBrowserEnv("https://chalk.q9labs.ai/dashboard");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ join_token: "join-token-123" }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);

    await expect(
      createRoomJoinLink("https://chalk-api.q9labs.ai", "room-123", "access-123"),
    ).resolves.toBe("https://chalkmeet.com/j/join-token-123");
  });
});

describe("getJoinContext", () => {
  afterEach(() => {
    restoreBrowserEnv();
  });

  it("returns internal room auth context on the matching room route", () => {
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

  it("skips eager token warmup on dashboard routes", () => {
    expect(shouldPrimeTokenCache("/dashboard")).toBe(false);
  });

  it("allows eager token warmup on room routes", () => {
    expect(shouldPrimeTokenCache("/room/2f0b302b-2449-43f5-ae3b-de57decb9f09")).toBe(true);
  });
});

describe("shouldUseRoomScopedTokenProvider", () => {
  it("uses room-scoped auth on room routes", () => {
    expect(shouldUseRoomScopedTokenProvider("/room/2f0b302b-2449-43f5-ae3b-de57decb9f09")).toBe(true);
  });

  it("uses room-scoped auth on join-link routes", () => {
    expect(shouldUseRoomScopedTokenProvider("/j/join-token-123")).toBe(true);
  });

  it("uses internal auth on dashboard routes", () => {
    expect(shouldUseRoomScopedTokenProvider("/dashboard")).toBe(true);
  });
});

describe("getChalkSessionCacheKey", () => {
  it("isolates dashboard session state from the generic app cache", () => {
    expect(getChalkSessionCacheKey("/dashboard", "")).toBe("dashboard");
  });

  it("keeps room session state keyed by room path and search", () => {
    expect(
      getChalkSessionCacheKey(
        "/room/2f0b302b-2449-43f5-ae3b-de57decb9f09",
        "?auth=internal",
      ),
    ).toBe(
      'room:/room/2f0b302b-2449-43f5-ae3b-de57decb9f09:"?auth=internal"',
    );
  });
});

describe("shouldUseInternalRoomAuth", () => {
  it("uses internal auth for dashboard room links flagged with auth=internal", () => {
    expect(
      shouldUseInternalRoomAuth(
        "/room/2f0b302b-2449-43f5-ae3b-de57decb9f09",
        "?auth=internal",
      ),
    ).toBe(true);
  });

  it("does not force internal auth for regular room links", () => {
    expect(
      shouldUseInternalRoomAuth(
        "/room/2f0b302b-2449-43f5-ae3b-de57decb9f09",
        "",
      ),
    ).toBe(false);
  });
});

describe("clearStoredChalkTokens", () => {
  afterEach(() => {
    restoreBrowserEnv();
  });

  it("removes sdk tokens from both browser stores", () => {
    const env = installBrowserEnv("https://chalkmeet.com/dashboard");
    env.localStorage.setItem("chalk_access_token", "abc");
    env.sessionStorage.setItem("chalk_refresh_token", "xyz");
    env.localStorage.setItem("chalk_token_expires", "123");

    clearStoredChalkTokens();

    expect(env.localStorage.getItem("chalk_access_token")).toBeNull();
    expect(env.sessionStorage.getItem("chalk_refresh_token")).toBeNull();
    expect(env.localStorage.getItem("chalk_token_expires")).toBeNull();
  });
});

describe("createWebTokenProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreBrowserEnv();
  });

  it("reuses a fresh internal room token for the current room", async () => {
    installBrowserEnv("https://chalkmeet.com/room/2f0b302b-2449-43f5-ae3b-de57decb9f09?auth=internal");
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
    installBrowserEnv("http://localhost:3070/dashboard");

    const first = getOrCreateLocalClientId();
    const second = getOrCreateLocalClientId();

    expect(first).toBeTruthy();
    expect(first).toBe(second);
  });

  it("keeps a stable client id on hosted origins", () => {
    installBrowserEnv("https://chalkmeet.com/dashboard");
    const first = getOrCreateLocalClientId();
    const second = getOrCreateLocalClientId();
    expect(first).toBeTruthy();
    expect(first).toBe(second);
  });
});
