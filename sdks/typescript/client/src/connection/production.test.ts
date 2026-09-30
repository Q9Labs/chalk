import { describe, expect, it, vi } from "vitest";

import { bindConnectionMediaClient } from "./production";

describe("production media adapter", () => {
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
    adapter.remotePublicationsChanged?.();
    adapter.remotePublicationResumed?.("publication-1");

    expect(source.setLocalSourceIntent).toHaveBeenCalledWith("camera", false);
    expect(source.closeForcedLocalPublication).toHaveBeenCalledWith("camera");
    expect(source.remotePublicationsChanged).toHaveBeenCalledOnce();
    expect(source.remotePublicationResumed).toHaveBeenCalledOnce();
  });
});
