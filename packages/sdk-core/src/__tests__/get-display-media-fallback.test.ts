import { afterEach, describe, expect, it, mock } from "bun:test";
import { withPatchedGetDisplayMedia } from "../utils/get-display-media-fallback.ts";

const setNavigator = (value: any) => {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
};

describe("withPatchedGetDisplayMedia", () => {
  const originalNavigator = (globalThis as any).navigator;

  afterEach(() => {
    setNavigator(originalNavigator);
  });

  it("requests screen-share audio by default on Chrome-like browsers", async () => {
    const calls: any[] = [];
    const getDisplayMedia = mock(async (constraints: any) => {
      calls.push(constraints);
      return { stream: true, constraints };
    });

    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      platform: "MacIntel",
      maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia },
    });

    await withPatchedGetDisplayMedia(async () => {
      await (navigator as any).mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: { max: 1920 } },
      });
      return true;
    });

    expect(calls.length).toBe(1);
    expect(calls[0].audio).toBe(true);
    expect(typeof calls[0].video).toBe("object");
  });

  it("defaults to audio=false on Safari when audio is not explicitly requested", async () => {
    const calls: any[] = [];
    const getDisplayMedia = mock(async (constraints: any) => {
      calls.push(constraints);
      return { stream: true, constraints };
    });

    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia },
    });

    await withPatchedGetDisplayMedia(async () => {
      await (navigator as any).mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: { max: 1920 } },
      });
      return true;
    });

    expect(calls.length).toBe(1);
    expect(calls[0].audio).toBe(false);
  });

  it("honors explicit withAudio=false even on Chrome-like browsers", async () => {
    const calls: any[] = [];
    const getDisplayMedia = mock(async (constraints: any) => {
      calls.push(constraints);
      return { stream: true, constraints };
    });

    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      platform: "MacIntel",
      maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia },
    });

    await withPatchedGetDisplayMedia(
      async () => {
        await (navigator as any).mediaDevices.getDisplayMedia({
          audio: true,
          video: { width: { max: 1920 } },
        });
        return true;
      },
      { withAudio: false },
    );

    expect(calls.length).toBe(1);
    expect(calls[0].audio).toBe(false);
  });

  it("retries without audio when audio=true fails", async () => {
    const calls: any[] = [];
    const getDisplayMedia = mock(async (constraints: any) => {
      calls.push(constraints);
      if (constraints?.audio === true) {
        const err = new Error("Could not start with audio");
        (err as any).name = "NotReadableError";
        throw err;
      }
      return { ok: true };
    });

    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      platform: "MacIntel",
      maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia },
    });

    await withPatchedGetDisplayMedia(
      async () => {
        await (navigator as any).mediaDevices.getDisplayMedia({
          audio: true,
          video: { width: { max: 1920 } },
        });
        return true;
      },
      { withAudio: true },
    );

    expect(calls.length).toBe(2);
    expect(calls[0].audio).toBe(true);
    expect(calls[1].audio).toBe(false);
  });

  it.each(["AbortError", "NotAllowedError"])("does not retry when the user cancels with %s", async (errorName) => {
    const calls: any[] = [];
    const getDisplayMedia = mock(async (constraints: any) => {
      calls.push(constraints);
      const err = new Error("User cancelled");
      (err as any).name = errorName;
      throw err;
    });

    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      platform: "MacIntel",
      maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia },
    });

    await expect(
      withPatchedGetDisplayMedia(
        async () => {
          await (navigator as any).mediaDevices.getDisplayMedia({
            audio: true,
            video: { width: { max: 1920 } },
          });
          return true;
        },
        { withAudio: true },
      ),
    ).rejects.toMatchObject({ name: errorName });

    expect(calls.length).toBe(1);
    expect(calls[0].audio).toBe(true);
  });

  it("retries with video-only when constraints are overconstrained", async () => {
    const calls: any[] = [];
    const getDisplayMedia = mock(async (constraints: any) => {
      calls.push(constraints);
      const err = new Error("Overconstrained");
      (err as any).name = "OverconstrainedError";
      throw err;
    });

    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      platform: "MacIntel",
      maxTouchPoints: 0,
      mediaDevices: { getDisplayMedia },
    });

    await expect(
      withPatchedGetDisplayMedia(
        async () => {
          await (navigator as any).mediaDevices.getDisplayMedia({
            audio: true,
            video: { width: { max: 1920 } },
          });
          return true;
        },
        { withAudio: true },
      ),
    ).rejects.toBeTruthy();

    // 1) original, 2) no-audio, 3) video-only
    expect(calls.length).toBe(3);
    expect(calls[2]).toEqual({ video: true });
  });

  it("restores the original getDisplayMedia after run()", async () => {
    const getDisplayMedia = mock(async () => ({ ok: true }));
    const md = { getDisplayMedia };
    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      platform: "MacIntel",
      maxTouchPoints: 0,
      mediaDevices: md,
    });

    const before = md.getDisplayMedia;

    await withPatchedGetDisplayMedia(async () => true);

    expect(md.getDisplayMedia).toBe(before);
  });
});
