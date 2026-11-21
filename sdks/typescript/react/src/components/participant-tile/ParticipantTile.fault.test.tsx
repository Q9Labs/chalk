// @vitest-environment jsdom
// Hop (a) of the render-side video chains: the real useVideoRenderProbe hook reads the mounted
// video element and reports video.render_probe and video.tile rows through the client's registered
// channel into the kernel and outbox. Each run pins the element's readings; the assembly hop stamps
// the frames and judges the rule. CHALK_CHAIN_WRITE=1 rewrites the files.
import { readFileSync, writeFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerVideoObservation, TelemetryOutbox } from "@q9labsai/chalk-client";
import type { TelemetryPlatform } from "@q9labsai/chalk-client";

type WireEvent = { readonly kind?: string; readonly seq: number } & Record<string, unknown>;
type LedgerFrame = { readonly body: string; readonly events: readonly WireEvent[] } & Record<string, unknown>;
import { useVideoRenderProbe } from "./useVideoRenderProbe";

const WALL_ORIGIN = 1_795_599_000_000;
const VIEWER = "b2000000-0000-4000-8000-000000000002";
const PUBLICATION = "0f8fad5b-0000-4000-8000-camerapub001";

import { join } from "node:path";
let lastVideo: HTMLVideoElement;
const chainDir = (code: string) => join(process.cwd(), "../../../observability/fixtures", code, "chain");
const framesFile = (code: string, run: string) => join(chainDir(code), `tile-frames.${run}.json`);

function chainTelemetry() {
  const frames: LedgerFrame[] = [];
  let mono = 1_000;
  let ids = 0;
  const platform: TelemetryPlatform = {
    now: () => mono,
    wall: () => WALL_ORIGIN + mono,
    uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    online: () => true,
    hidden: () => false,
    subscribe: () => () => undefined,
    send: async (request) => {
      const frame = JSON.parse(request.body) as LedgerFrame;
      frames.push(frame);
      return { status: 200, retryAfterMs: 0, acks: frame.events.map((event) => ({ from: event.seq, to: event.seq + 1 })), serverMs: WALL_ORIGIN + mono };
    },
  };
  const outbox = new TelemetryOutbox({ platform, endpoint: (tenantId) => `https://api.test/v1/tenants/${tenantId}/telemetry`, random: () => 0.5, liveSources: new Set(), build: { module: "sdk", env: "test", platform: "web" }, obsMode: "closed" });
  outbox.bind({ current: () => ({ tenantId: "c1000000-0000-4000-8000-000000000001", subject: `c1000000-0000-4000-8000-000000000001/0f8fad5b-d9cb-469f-a165-70867728950e/${VIEWER}`, token: "token", expiresAt: WALL_ORIGIN + 3_600_000 }), refresh: async () => undefined });
  // The media client's registration (media/client.ts) routes tile reports into this outbox.
  registerVideoObservation({
    surface: (fields) => outbox.obs?.surface("video.tile", fields) ?? { dismiss() {} },
    probe: (fields) => outbox.obs?.fact("video.render_probe", fields),
  });
  return { outbox, frames, advance: (ms: number) => (mono += ms) };
}

const kernelRows = (frames: readonly LedgerFrame[]): unknown[] => frames.flatMap((frame) => frame.events.filter((event): event is WireEvent => "kind" in event && typeof event.kind === "string"));
const strip = (rows: readonly unknown[]) => rows.map((row) => {
  const { schema_ver: _schema_ver, ...rest } = row as Record<string, unknown>;
  return rest;
});

/** A video element pinned to the readings the run needs. */
function fakeVideo(presented: () => number) {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    readyState: { value: 4, configurable: true },
    videoWidth: { value: 640, configurable: true },
    videoHeight: { value: 360, configurable: true },
  });
  video.getBoundingClientRect = () => ({ left: 10, top: 10, width: 320, height: 180, right: 330, bottom: 190, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
  video.getVideoPlaybackQuality = () => ({ totalVideoFrames: presented(), droppedVideoFrames: 0 }) as VideoPlaybackQuality;
  return video;
}

type TileProps = { readonly state: "picture" | "avatar" | "paused_for_network" | "frozen_frame" | "media_state"; readonly presented: () => number };

function Tile({ state, presented }: TileProps) {
  const ref = { current: null as HTMLVideoElement | null };
  if (!ref.current) ref.current = lastVideo = fakeVideo(presented);
  useVideoRenderProbe(ref, null, "live", { state, statusShown: state === "picture", publicationId: PUBLICATION, local: false });
  return null;
}

async function runTile(code: string, run: "positive" | "healthy") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
  // elementFromPoint returns the tile itself: nothing covers it.
  document.elementFromPoint = () => lastVideo;
  // jsdom has no canvas; the stub reads a flat mid-grey frame so luma is a real read of the stub.
  const pixels = new Uint8ClampedArray(8 * 8 * 4).fill(128);
  const canvasContext = { drawImage: () => undefined, getImageData: () => ({ data: pixels }) };
  const realCreateElement = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const el = realCreateElement(tag);
    if (tag === "canvas") (el as HTMLCanvasElement).getContext = (() => canvasContext) as never;
    return el;
  }) as typeof document.createElement;
  const { outbox, frames, advance } = chainTelemetry();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const scenarios: Record<string, Record<string, TileProps["state"][]>> = {
    "video.not_shown": { positive: ["avatar"], healthy: ["picture"] },
    "video.frozen": { positive: ["picture"], healthy: ["picture"] },
    "video.low_quality": { positive: ["picture", "paused_for_network"], healthy: ["picture"] },
  };
  const presentedCounts: Record<string, () => number> = {
    positive: (() => { let n = 0; return () => (code === "video.not_shown" ? 0 : (n = 400, n)); })(),
    healthy: (() => { let n = 0; return () => (n += 60); })(),
  };
  const states = scenarios[code][run];
  act(() => root.render(<Tile state={states[0]} presented={presentedCounts[run]} />));
  // Three probe ticks, each one render window later.
  for (let step = 0; step < 2; step++) {
    await act(async () => {
      advance(9_000);
      await vi.advanceTimersByTimeAsync(2_000);
    });
  }
  if (states[1]) act(() => root.render(<Tile state={states[1]} presented={presentedCounts[run]} />));
  await act(async () => {
    advance(9_000);
    await vi.advanceTimersByTimeAsync(2_000);
  });
  act(() => root.unmount());
  await outbox.dispose();
  vi.unstubAllGlobals();
  const rows = strip(kernelRows(frames));
  const file = framesFile(code, run);
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
  expect(rows, `${file} is stale: rerun with CHALK_CHAIN_WRITE=1`).toEqual(JSON.parse(readFileSync(file, "utf8")));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

import { beforeEach } from "vitest";

describe("video tile chain, hop (a)", () => {
  for (const code of ["video.not_shown", "video.frozen", "video.low_quality"]) {
    for (const run of ["positive", "healthy"] as const) {
      it(`${code} ${run} produces the committed tile rows`, () => runTile(code, run));
    }
  }
});
