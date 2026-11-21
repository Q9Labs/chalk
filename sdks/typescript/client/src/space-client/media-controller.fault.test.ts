// Fault scenarios for the camera symptoms (observability/registry/areas/video.json), hop (a) of their chains.
// Each run drives the real space client, media controller, kernel and outbox on a fixed clock and keeps the wire
// events the outbox sends; the assembly hop stamps them into stored rows and judges the rule
// (observability/fixtures/video.camera_wont_start/README.md). CHALK_CHAIN_WRITE=1 rewrites them.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_VER } from "../obs/registry";
import { TelemetryOutbox } from "../telemetry/outbox";
import type { LedgerFrame, TelemetryPlatform, WireEvent } from "../telemetry/types";
import { createCoreTestPlatform } from "./core.test.helpers";
import { captureClient, noCaptureDevices, stream, track } from "./capture.test.helpers";

type Run = "wont_start" | "stopped" | "healthy";

const CODES: Record<string, readonly Run[]> = {
  "video.camera_wont_start": ["wont_start", "stopped", "healthy"],
  "video.camera_stopped": ["wont_start", "stopped", "healthy"],
  // video.not_published's story needs the camera live and bound: its publish path is the failing hop.
  "video.not_published": ["healthy"],
};
const chainDir = (code: string) => new URL(`../../../../../observability/fixtures/${code}/chain/`, import.meta.url);
const framesFile = (code: string, run: Run) => new URL(`client-frames.${run}.json`, chainDir(code));

const WALL_ORIGIN = 1_795_599_000_000;

beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  // A platform that answers the capture probes: permission granted, no policy block.
  vi.stubGlobal("navigator", {
    ...(globalThis.navigator ?? {}),
    permissions: { query: async () => ({ state: "granted" }) },
  });
  vi.stubGlobal("document", { permissionsPolicy: { allowsFeature: () => true } });
});
afterEach(() => vi.unstubAllGlobals());

/** A telemetry platform on a fixed clock that keeps the frames it posts, so every run's wire rows are identical. */
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
      const frame: LedgerFrame = JSON.parse(request.body);
      frames.push(frame);
      mono += 40;
      return { status: 200, retryAfterMs: 0, acks: frame.events.map((event) => ({ from: event.seq, to: event.seq + 1 })), serverMs: 1_795_600_000_000 };
    },
  };
  const outbox = new TelemetryOutbox({ platform, endpoint: (tenantId) => `https://api.test/v1/tenants/${tenantId}/telemetry`, random: () => 0.5, liveSources: new Set(), build: { module: "sdk", env: "test", platform: "web" }, obsMode: "closed" });
  outbox.bind({ current: () => ({ tenantId: "c1000000-0000-4000-8000-000000000001", subject: "c1000000-0000-4000-8000-000000000001/0f8fad5b-d9cb-469f-a165-70867728950e/a1000000-0000-4000-8000-000000000001", token: "token", expiresAt: WALL_ORIGIN + 3_600_000 }), refresh: async () => undefined });
  return { outbox, frames };
}

/** The kernel records one run's frames carried, in seq order. */
const kernelRows = (frames: readonly LedgerFrame[]): unknown[] => frames.flatMap((frame) => frame.events.filter((event): event is WireEvent => "kind" in event && typeof event.kind === "string"));

// A frame as JSON without schema_ver: the registry's content hash changes with any registry edit, so the hand-off leaves it out.
const strip = (rows: readonly unknown[]) => rows.map((row) => {
  const { schema_ver: _schema_ver, ...rest } = row as Record<string, unknown>;
  return rest;
});

describe("video camera chain, hop (a)", () => {
  it.each(["wont_start", "stopped", "healthy"] as const)("%s produces the committed client rows", async (run) => {
    const { outbox, frames } = chainTelemetry();
    const platform = createCoreTestPlatform();
    const video = track("video");
    const getUserMedia = vi.fn(async () => {
      if (run === "wont_start") noCaptureDevices();
      return stream([video]);
    });
    const client = captureClient(platform, {
      telemetry: outbox,
      mediaDevices: { releaseTrack: (stopped) => stopped.stop(), getUserMedia, enumerateDevices: async () => [] },
    });
    try {
      await client.join({ microphone: false, camera: false });
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("live"));
      // The capture failure is the product's own error path: the call rejects, the rows say why.
      await client.media.setCameraEnabled(true).catch(() => undefined);
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
      if (run !== "wont_start") await vi.waitFor(() => expect(client.getSnapshot().media.local.camera.track).not.toBeNull());
      if (run === "stopped") video.dispatchEvent(new Event("ended"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      client.dispose();
    }
    await outbox.dispose();
    const rows = strip(kernelRows(frames));
    for (const [code, runs] of Object.entries(CODES)) {
      if (!runs.includes(run)) continue;
      const file = framesFile(code, run);
      const path = file.pathname;
      if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
      expect(rows, `${path} is stale: rerun with CHALK_CHAIN_WRITE=1`).toEqual(JSON.parse(readFileSync(file, "utf8")));
    }
    expect(rows.length, `${run}: the camera path emitted no kernel rows`).toBeGreaterThan(0);
    expect(SCHEMA_VER.length).toBeGreaterThan(0);
  });
});
