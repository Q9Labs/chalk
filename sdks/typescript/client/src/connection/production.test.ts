import { describe, expect, it, vi } from "vitest";

import { parseParsedAccessGrant } from "../access/grant";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";

import { createDefaultConnectionDependencies, bindConnectionMediaClient } from "./production";

const whiteboard = vi.hoisted(() => vi.fn());
vi.mock("../whiteboard", async (original) => ({ ...(await original<typeof import("../whiteboard")>()), createChalkWhiteboardV1Client: whiteboard }));

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

describe("production admission cancellation", () => {
  it.each([true, false])("preserves a confirmed %s outcome", async (cancelled) => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ cancelled })));
    try {
      const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1" });
      await expect(dependencies.cancelPendingAdmission?.(parseParsedAccessGrant(opaqueAccessGrant(1)), new AbortController().signal)).resolves.toBe(cancelled);
    } finally {
      request.mockRestore();
    }
  });
  it("does not turn an invalid cancellation response into confirmed non-cancellation", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      const dependencies = createDefaultConnectionDependencies({ apiBaseURL: "https://api.test", syncURL: "wss://sync.test/v1" });
      await expect(dependencies.cancelPendingAdmission?.(parseParsedAccessGrant(opaqueAccessGrant(1)), new AbortController().signal)).rejects.toThrow("invalid outcome");
    } finally {
      request.mockRestore();
    }
  });
});
