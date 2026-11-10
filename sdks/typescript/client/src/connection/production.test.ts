import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ownSFUGrant } from "../space-client/core.test.helpers";
import { createDefaultConnectionDependencies, bindConnectionMediaClient } from "./production";
import type { ConnectionMediaClient } from "./dependencies";

const whiteboard = vi.hoisted(() => vi.fn());
const syncClient = vi.hoisted(() => vi.fn());
const mediaTransport = vi.hoisted(() => vi.fn());
vi.mock("../whiteboard", async (original) => ({ ...(await original<typeof import("../whiteboard")>()), createChalkWhiteboardV1Client: whiteboard }));
vi.mock("../sync", async (original) => ({ ...(await original<typeof import("../sync")>()), createV1SyncClient: syncClient }));
vi.mock("../media", async (original) => ({ ...(await original<typeof import("../media")>()), createCloudflareSFUHTTPTransport: mediaTransport }));

describe("production whiteboard adapter", () => {
  it("forwards the shared core's watchdog recorder", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1" });
    const onWatchdogReplacement = vi.fn();
    dependencies.createWhiteboardClient?.({ token: async () => "unused", onSummary: vi.fn(), onWatchdogReplacement });
    expect(whiteboard).toHaveBeenCalledOnce();
    expect(whiteboard.mock.calls[0]?.[0].onWatchdogReplacement).toBe(onWatchdogReplacement);
  });
});

describe("production media adapter", () => {
  it("forwards privacy controls and projection notifications with the source binding", async () => {
    const source = {
      prepareLocalPublicationTarget: vi.fn(async function (this: object) {
        expect(this).toBe(source);
      }),
      setLocalPublicationTarget: vi.fn(),
      setLocalSourceIntent: vi.fn(function (this: object) {
        expect(this).toBe(source);
      }),
      closeForcedLocalPublication: vi.fn(async function (this: object) {
        expect(this).toBe(source);
      }),
      observeLocalPublications: vi.fn(),
      observeRemotePublications: vi.fn(),
      remotePublicationsChanged: vi.fn(function (this: object) {
        expect(this).toBe(source);
      }),
      remotePublicationResumed: vi.fn(function (this: object, publicationId: string) {
        expect(this).toBe(source);
        expect(publicationId).toBe("publication-1");
      }),
      start: vi.fn(),
      stop: vi.fn(),
      prepareLocalTrack: vi.fn(),
      clearPreparedLocalTrack: vi.fn(),
      getSnapshot: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as Parameters<typeof bindConnectionMediaClient>[0];
    const restart = vi.fn() as unknown as Parameters<typeof bindConnectionMediaClient>[1];
    const adapter = bindConnectionMediaClient(source, restart);
    const target = { source: "camera", enabled: true } as unknown as Parameters<typeof adapter.prepareLocalPublicationTarget>[0];

    await adapter.prepareLocalPublicationTarget(target);
    adapter.setLocalSourceIntent?.("camera", false);
    await adapter.closeForcedLocalPublication?.("camera");
    adapter.remotePublicationsChanged?.();
    adapter.remotePublicationResumed?.("publication-1");

    expect(source.prepareLocalPublicationTarget).toHaveBeenCalledWith(target);
    expect(source.setLocalSourceIntent).toHaveBeenCalledWith("camera", false);
    expect(source.closeForcedLocalPublication).toHaveBeenCalledWith("camera");
    expect(source.remotePublicationsChanged).toHaveBeenCalledOnce();
    expect(source.remotePublicationResumed).toHaveBeenCalledOnce();
  });
});

describe("direct door", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        addEventListener() {}
        close() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  const advertised = ownSFUGrant({ unifiedSignaling: true, directSignalingUrl: "https://direct.example.test" });
  const silent = ownSFUGrant({ unifiedSignaling: true });
  const syncInput = (access: typeof advertised, onTransportPath = vi.fn()) => ({ access, token: async () => "token", media: {} as ConnectionMediaClient, onTransportPath });
  const mediaInput = (access: typeof advertised, onTransportPath = vi.fn()) => ({ access, credential: async () => "token", onFailure: vi.fn(), onScreenEnded: vi.fn(), onTransportPath });
  const syncOptions = () => syncClient.mock.lastCall?.[0];
  const transportOptions = () => mediaTransport.mock.lastCall?.[0];

  it("dials Sync and sends signalling to the door the grant advertises", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync" });

    dependencies.createSyncClient(syncInput(advertised));
    dependencies.createMediaClient(mediaInput(advertised));

    expect(syncOptions().webSocket).toBeDefined();
    expect(transportOptions()).toMatchObject({ apiBaseURL: "https://api.test", directBaseURL: "https://direct.example.test" });
  });

  it("keeps both on the Tunnel when the grant advertises none, and reports the Tunnel for Sync", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync" });
    const onPath = vi.fn();

    dependencies.createSyncClient(syncInput(silent, onPath));
    dependencies.createMediaClient(mediaInput(silent));

    expect(syncOptions().webSocket).toBeUndefined();
    expect(transportOptions()).not.toHaveProperty("directBaseURL");
    expect(onPath).toHaveBeenCalledWith({ plane: "sync", path: "tunnel", fellBack: false });
  });

  it("keeps both on the Tunnel when the platform turns the door off, even for a configured Sync door", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync", syncDirectURL: "wss://configured.example.test/v1/sync", directPath: "off" });
    const onPath = vi.fn();

    dependencies.createSyncClient(syncInput(advertised, onPath));
    dependencies.createMediaClient(mediaInput(advertised));

    expect(syncOptions().webSocket).toBeUndefined();
    expect(transportOptions()).not.toHaveProperty("directBaseURL");
    expect(onPath).toHaveBeenCalledWith({ plane: "sync", path: "tunnel", fellBack: false });
  });

  it("prefers a configured Sync door over the advertised one, so the lobby warm socket is adopted", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync", syncDirectURL: "wss://configured.example.test/v1/sync" });

    dependencies.createSyncClient(syncInput(silent));

    expect(syncOptions().webSocket).toBeDefined();
  });
});
