import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { resolveBackgroundImageSource } from "../conference-session/resolve-background-image-source.ts";

describe("resolveBackgroundImageSource", () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalUrl = globalThis.URL;
  const createObjectUrl = mock(() => "blob:resolved-background");
  const revokeObjectUrl = mock(() => {});

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {} as Window & typeof globalThis,
    });

    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: {
        ...URL,
        createObjectURL: createObjectUrl,
        revokeObjectURL: revokeObjectUrl,
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });

    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: originalUrl,
    });

    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
  });

  it("returns blob URLs as-is without fetching", async () => {
    const fetchMock = mock();
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await resolveBackgroundImageSource("blob:already-local");

    expect(result.imageUrl).toBe("blob:already-local");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches remote images and converts them to object URLs", async () => {
    const imageBlob = new Blob(["img"], { type: "image/png" });
    globalThis.fetch = mock(async () => new Response(imageBlob, { status: 200 })) as typeof fetch;

    const result = await resolveBackgroundImageSource("https://cdn.example.com/background.png");

    expect(globalThis.fetch).toHaveBeenCalledWith("https://cdn.example.com/background.png");
    expect(result.imageUrl).toBe("blob:resolved-background");
    result.revoke?.();
    expect(createObjectUrl).toHaveBeenCalledWith(imageBlob);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:resolved-background");
  });
});
