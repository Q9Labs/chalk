import { parseParsedAccessGrant } from "../access/grant";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";
import { V1SyncClient } from "../sync/v1-client";
import * as sync from "../sync";
import { describe, expect, it, vi } from "vitest";

import { createDefaultConnectionDependencies, bindConnectionMediaClient } from "./production";

describe("production media adapter", () => {
  it("preserves Sync transport restart and timeout telemetry options through the real factory", () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { onLine: true });
    const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1/sync" });
    const access = parseParsedAccessGrant(opaqueAccessGrant(1));
    const media = bindConnectionMediaClient(
      {
        setLocalPublicationTarget: vi.fn(),
        observeLocalPublications: () => () => {},
        observeRemotePublications: () => () => {},
        start: vi.fn(),
        stop: vi.fn(),
        prepareLocalTrack: vi.fn(),
        clearPreparedLocalTrack: vi.fn(),
        getSnapshot: vi.fn(),
        subscribe: vi.fn(),
      } as unknown as Parameters<typeof bindConnectionMediaClient>[0],
      vi.fn(),
    );
    const recordReconnect = vi.fn();
    const factory = vi.spyOn(sync, "createV1SyncClient");
    const restart = vi.spyOn(V1SyncClient.prototype, "restartTransport").mockImplementation(function () {
      expect(this).toBe(client);
    });
    const client = dependencies.createSyncClient({ access, token: async () => "token", media, commandTimeoutMs: 123, recordReconnect });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ commandTimeoutMs: 123, recordReconnect, mediaPlane: media }));
    client.restartTransport?.();
    expect(restart).toHaveBeenCalledOnce();
    client.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("forwards privacy controls and projection notifications with the source binding", async () => {
    const source = {
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
      setRemotePublicationTargets: vi.fn(function (this: object) {
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

    adapter.setLocalSourceIntent?.("camera", false);
    await adapter.closeForcedLocalPublication?.("camera");
    adapter.setRemotePublicationTargets?.([{ participantId: "remote", publicationId: "publication-1", source: "camera", enabled: false }]);
    adapter.remotePublicationsChanged?.();
    adapter.remotePublicationResumed?.("publication-1");

    expect(source.setLocalSourceIntent).toHaveBeenCalledWith("camera", false);
    expect(source.closeForcedLocalPublication).toHaveBeenCalledWith("camera");
    expect(source.setRemotePublicationTargets).toHaveBeenCalledWith([{ participantId: "remote", publicationId: "publication-1", source: "camera", enabled: false }]);
    expect(source.remotePublicationsChanged).toHaveBeenCalledOnce();
    expect(source.remotePublicationResumed).toHaveBeenCalledOnce();
  });
});
