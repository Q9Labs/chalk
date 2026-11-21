import { afterEach, expect, test, vi } from "vitest";
import type { ScreenAnnotationHelperShare } from "@q9labsai/chalk-react";
import { createBrowserAnnotationHelper } from "./screen-annotation-helper";
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

test("window exclusion does not complete before the renderer acknowledges the probe", async () => {
  const video = {
    style: {},
    videoWidth: 640,
    videoHeight: 360,
    setAttribute() {},
    remove() {},
    play: async () => {},
    requestVideoFrameCallback: (callback: () => void) => setTimeout(callback, 0),
    cancelVideoFrameCallback: clearTimeout,
  };
  const context = { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(72 * 72 * 4) }) };
  vi.stubGlobal("MediaStream", class {});
  vi.stubGlobal("document", {
    body: { appendChild() {} },
    createElement: (name: string) => (name === "video" ? video : { getContext: () => context }),
  });
  const track = { enabled: true, readyState: "live", clone: () => ({ enabled: true, stop() {} }) } as MediaStreamTrack;
  const complete = vi.fn(async () => {});
  const paint = vi.fn(async () => { throw new Error("no renderer acknowledgement"); });
  const point = { x: 0.5, y: 0.5, rgb: [255, 0, 255] as [number, number, number] };
  const probe = { nonce: "A".repeat(22), points: [point, point, point] as [typeof point, typeof point, typeof point] };
  const options: Parameters<typeof calibrateWindow>[0] = {
    track,
    signal: new AbortController().signal,
    verify: async () => true,
    start: async () => probe,
    painted: paint,
    complete,
    abort: async () => {},
  };
  await calibrateWindow(options);
  expect(complete).not.toHaveBeenCalled();
  expect(track.enabled).toBe(true);
  expect(paint).toHaveBeenCalledWith(probe.nonce, expect.any(AbortSignal));
});
