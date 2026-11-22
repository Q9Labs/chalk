import { afterEach, expect, test, vi } from "vitest";
import type { ScreenAnnotationHelperShare } from "@q9labsai/chalk-react";
import { createBrowserAnnotationHelper } from "./screen-annotation-helper";
import { HelperConflict } from "./screen-annotation-helper-bridge";
import { calibrateWindow } from "./screen-annotation-helper-calibration";

afterEach(() => vi.unstubAllGlobals());

test("a loopback listener without native confirmation never receives a capture description", async () => {
  const origin = "https://chalk.example";
  const layer = { layer_id: "layer", publication_id: "publication", sharer_id: "sharer" };
  const share = {
    client: { getSnapshot: () => ({ status: "ready", state: { layer } }), subscribe: () => () => {} },
    layer,
    participantId: "sharer",
    surface: null,
  } as unknown as ScreenAnnotationHelperShare;
  vi.stubGlobal("window", { isSecureContext: true, location: { origin } });
  const expiry = Date.now() + 40_000;
  const key = "A".repeat(43);
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, request?: RequestInit) => {
    const path = new URL(url).pathname;
    sent.push(path);
    if (path === "/v1/challenge") return Response.json({ version: 2, helperPublicKey: key, challenge: key, expiresAtMs: expiry });
    if (path === "/v1/attach") {
      expect(request?.body).not.toContain("a.t.t");
      return Response.json({ sessionSecret: key, leaseExpiresAtMs: expiry, confirmation: "A".repeat(86) });
    }
    return new Response(null, { status: 409 });
  });
  const helper = createBrowserAnnotationHelper({
    origin,
    authority: { issueLocalTicket: async () => ({ pair: { ticket: "p.a.r", expiresAtMs: expiry }, attachment: { ticket: "a.t.t", expiresAtMs: expiry } }) },
  });
  const approval = await helper.challenge?.(share, new AbortController().signal);
  expect(approval?.kind).toBe("approval");
  if (approval?.kind !== "approval") return;
  const statuses: string[] = [];
  await expect(approval.attach((status) => statuses.push(status), async () => "ABCD-EFGH-JKLM-NPQR")).rejects.toThrow();
  expect(sent).not.toContain("/v1/exchange");
  expect(statuses).not.toContain("ready");
});

function windowCalibration(captureTime?: (now: number) => number | undefined) {
  const controller = new AbortController();
  let callbacks = 0;
  const video = {
    style: {},
    videoWidth: 640,
    videoHeight: 360,
    setAttribute() {},
    remove() {},
    play: async () => {},
    requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => setTimeout(() => {
      callbacks++;
      if (callbacks > 5) {
        controller.abort();
        return;
      }
      const now = performance.now();
      callback(now, {
        captureTime: captureTime?.(now),
        presentationTime: now,
        expectedDisplayTime: now,
        presentedFrames: callbacks,
        mediaTime: callbacks / 60,
        width: 640,
        height: 360,
      });
    }, 5),
    cancelVideoFrameCallback: clearTimeout,
  };
  const context = { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(72 * 72 * 4) }) };
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("document", {
    body: { appendChild() {} },
    createElement: (name: string) => (name === "video" ? video : { getContext: () => context }),
  });
  const track = { enabled: true, readyState: "live", clone: () => ({ enabled: true, stop() {} }) } as MediaStreamTrack;
  const point = { x: 0.5, y: 0.5, rgb: [255, 0, 255] as [number, number, number] };
  const probe = { nonce: "A".repeat(22), points: [point, point, point] as [typeof point, typeof point, typeof point] };
  return {
    track,
    signal: controller.signal,
    verify: async () => true,
    start: async () => probe,
    painted: vi.fn(async (_nonce: string, _signal: AbortSignal) => {
      expect(track.enabled).toBe(false);
    }),
    complete: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}

test("window exclusion does not complete before the renderer acknowledges the probe", async () => {
  const options = windowCalibration(now => now);
  options.painted.mockRejectedValueOnce(new Error("no renderer acknowledgement"));
  await calibrateWindow(options);
  expect(options.complete).not.toHaveBeenCalled();
  expect(options.abort).toHaveBeenCalledOnce();
  expect(options.track.enabled).toBe(true);
  expect(options.painted).toHaveBeenCalledWith("A".repeat(22), expect.any(AbortSignal));
});

test("delayed pre-paint frames cannot prove window exclusion after acknowledgement", async () => {
  let capturedBeforePaint = 0;
  const options = windowCalibration(() => capturedBeforePaint++);
  options.painted.mockImplementationOnce(async () => {
    capturedBeforePaint = performance.now() - 100;
    expect(options.track.enabled).toBe(false);
  });
  await calibrateWindow(options);
  expect(options.complete).not.toHaveBeenCalled();
  expect(options.abort).toHaveBeenCalledOnce();
  expect(options.track.enabled).toBe(true);
});

test("window exclusion fails closed without capture timestamps", async () => {
  const options = windowCalibration();
  await calibrateWindow(options);
  expect(options.complete).not.toHaveBeenCalled();
  expect(options.abort).toHaveBeenCalledOnce();
  expect(options.track.enabled).toBe(true);
});

test("window exclusion can complete with four distinct post-paint captures", async () => {
  const options = windowCalibration(now => now);
  await calibrateWindow(options);
  expect(options.complete).toHaveBeenCalledOnce();
  expect(options.abort).not.toHaveBeenCalled();
  expect(options.track.enabled).toBe(true);
});

test("a stale request to start a window probe does not tear down a ready overlay", async () => {
  const options = windowCalibration(now => now);
  await calibrateWindow({
    ...options,
    start: async () => {
      throw new HelperConflict("A probe is already ready.");
    },
  });
  expect(options.painted).not.toHaveBeenCalled();
  expect(options.abort).not.toHaveBeenCalled();
  expect(options.track.enabled).toBe(true);
});

test("an uncertain window probe start still clears the native probe before resuming the share", async () => {
  const options = windowCalibration(now => now);
  options.abort.mockImplementationOnce(async () => {
    expect(options.track.enabled).toBe(false);
  });
  await calibrateWindow({
    ...options,
    start: async () => { throw new Error("The response was lost."); },
  });
  expect(options.abort).toHaveBeenCalledOnce();
  expect(options.track.enabled).toBe(true);
});
