import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveApiUrl, startMagicLink, verifyMagicLink } from "./internalAuth";

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

describe("startMagicLink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests dashboard as the default callback url", async () => {
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
