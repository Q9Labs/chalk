import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredChalkTokens,
  fetchInternalAccessToken,
  fetchInternalSession,
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
      resolveApiUrl("https://chalk-api.q9labs.ai", "chalk.q9labs.ai"),
    ).toBe("https://chalk-api.q9labs.ai");
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

describe("getJoinContext", () => {
  afterEach(() => {
    restoreBrowserEnv();
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

  it("keeps api-key auth available on non-room routes", () => {
    expect(shouldUseRoomScopedTokenProvider("/dashboard")).toBe(false);
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
    const env = installBrowserEnv("https://chalk.q9labs.ai/dashboard");
    env.localStorage.setItem("chalk_access_token", "abc");
    env.sessionStorage.setItem("chalk_refresh_token", "xyz");
    env.localStorage.setItem("chalk_token_expires", "123");

    clearStoredChalkTokens();

    expect(env.localStorage.getItem("chalk_access_token")).toBeNull();
    expect(env.sessionStorage.getItem("chalk_refresh_token")).toBeNull();
    expect(env.localStorage.getItem("chalk_token_expires")).toBeNull();
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

  it("returns null on hosted origins", () => {
    installBrowserEnv("https://chalk.q9labs.ai/dashboard");
    expect(getOrCreateLocalClientId()).toBeNull();
  });
});
