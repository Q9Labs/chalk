import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadRecordingFromDashboard, getRecordingPlaybackUrl, getRecordingShareUrl } from "./dashboardMeetings";

const originalWindow = globalThis.window;

function installWindow(origin = "https://chalkmeet.com") {
  const open = vi.fn();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: new URL(origin),
      open,
    },
    writable: true,
  });
  return { open };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
    writable: true,
  });
});

describe("getRecordingPlaybackUrl", () => {
  it("uses the recordings download endpoint and returns the presigned URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ready", download_url: "https://r2.example.com/file.mp4" }),
    } as Response);

    await expect(getRecordingPlaybackUrl("https://chalk-api.q9labs.ai", "rec_123", "token-123")).resolves.toBe("https://r2.example.com/file.mp4");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://chalk-api.q9labs.ai/api/v1/recordings/rec_123/download",
      expect.objectContaining({
        headers: { Authorization: "Bearer token-123" },
      }),
    );
  });

  it("surfaces a processing recording as a user-facing error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "processing", message: "recording is still processing" }),
    } as Response);

    await expect(getRecordingPlaybackUrl("https://chalk-api.q9labs.ai", "rec_123", "token-123")).rejects.toThrow("recording is still processing");
  });
});

describe("getRecordingShareUrl", () => {
  it("builds a public share URL from the recordings share endpoint", async () => {
    installWindow();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ share_token: "share-123" }),
    } as Response);

    await expect(getRecordingShareUrl("https://chalk-api.q9labs.ai", "rec_123", "token-123")).resolves.toBe("https://chalkmeet.com/share/share-123");
  });
});

describe("downloadRecordingFromDashboard", () => {
  it("opens the playback URL in a new tab", async () => {
    const { open } = installWindow();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "ready", download_url: "https://r2.example.com/file.mp4" }),
    } as Response);

    await downloadRecordingFromDashboard("https://chalk-api.q9labs.ai", "rec_123", "token-123");

    expect(open).toHaveBeenCalledWith("https://r2.example.com/file.mp4", "_blank", "noopener,noreferrer");
  });
});
