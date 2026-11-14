import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chalkSFUGrant } from "../space-client/core.test.helpers";
import { createDefaultConnectionDependencies, bindConnectionMediaClient } from "./production";
import type { ConnectionMediaClient } from "./dependencies";

describe("production media adapter", () => {
  it("forwards privacy controls and projection notifications with the source binding", async () => {
    const source = {
      prepareLocalPublicationTarget: vi.fn(async function (this: object) {
        expect(this).toBe(source);
      }),
      cancelPreparedLocalPublicationTarget: vi.fn(),
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
  const requested: string[] = [];
  beforeEach(() => {
    requested.length = 0;
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        addEventListener() {}
        removeEventListener() {}
        getSenders() {
          return [];
        }
        getReceivers() {
          return [];
        }
        getTransceivers() {
          return [];
        }
        close() {}
      },
    );
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requested.push(new Request(input).url);
      return new Response("{}", { status: 500 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const advertised = chalkSFUGrant({ unifiedSignaling: true, directSignalingUrl: "https://direct.example.test" });
  const silent = chalkSFUGrant({ unifiedSignaling: true });
  const syncInput = (access: typeof advertised, onTransportPath = vi.fn()) => ({ access, token: async () => "token", media: {} as ConnectionMediaClient, onTransportPath });
  const mediaInput = (access: typeof advertised) => ({ access, credential: async () => "token", onFailure: vi.fn(), onScreenEnded: vi.fn() });
  const noLocalTracks = { getTracks: () => [] } as unknown as MediaStream;
  const firstSignallingOrigin = async (dependencies: ReturnType<typeof createDefaultConnectionDependencies>, access: typeof advertised) => {
    const media = dependencies.createMediaClient(mediaInput(access));
    await media.start(noLocalTracks).catch(() => undefined);
    media.remotePublicationsChanged?.();
    await vi.waitFor(() => expect(requested.length).toBeGreaterThan(0));
    media.stop();
    return new URL(requested[0] ?? "about:blank").origin;
  };

  it("sends media signalling to the door the grant advertises", async () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync" });

    expect(await firstSignallingOrigin(dependencies, advertised)).toBe("https://direct.example.test");
  });

  it("keeps media signalling on the Tunnel when the grant advertises no door", async () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync" });

    expect(await firstSignallingOrigin(dependencies, silent)).toBe("https://api.test");
  });

  it("keeps media signalling on the Tunnel when the platform turns the door off", async () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync", directPath: "off" });

    expect(await firstSignallingOrigin(dependencies, advertised)).toBe("https://api.test");
  });

  it("reports the Tunnel for Sync when the grant advertises no door", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync" });
    const onPath = vi.fn();

    dependencies.createSyncClient(syncInput(silent, onPath));

    expect(onPath).toHaveBeenCalledWith({ plane: "sync", path: "tunnel", fellBack: false });
  });

  it("reports the Tunnel for Sync when the platform turns the door off, even for a configured Sync door", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync", syncDirectURL: "wss://configured.example.test/v1/sync", directPath: "off" });
    const onPath = vi.fn();

    dependencies.createSyncClient(syncInput(advertised, onPath));

    expect(onPath).toHaveBeenCalledWith({ plane: "sync", path: "tunnel", fellBack: false });
  });

  it("does not report the Tunnel for Sync when a door applies", () => {
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync", syncDirectURL: "wss://configured.example.test/v1/sync" });
    const onPath = vi.fn();

    dependencies.createSyncClient(syncInput(silent, onPath));

    expect(onPath).not.toHaveBeenCalled();
  });
});
