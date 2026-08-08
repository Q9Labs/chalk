import type { GetAccess, SpaceClient } from "@q9labsai/chalk-client";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";
import { describe, expect, it, vi } from "vitest";

const nativeClientFactory = vi.hoisted(() => vi.fn());
const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
}));

vi.mock("@q9labsai/chalk-react-native/client", () => ({ createNativeSpaceClient: nativeClientFactory }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: asyncStorage }));

import { createMobileSpaceClient, createMobileSpaceRelease, ownMobileSpaceClient } from "./mobile-space-client";

const credential = {
  apiBaseURL: "https://api.chalkmeet.com",
  participantCredentialId: "c".repeat(43),
  spaceInviteToken: "i".repeat(43),
  syncURL: "wss://sync.chalkmeet.com/v1/sync",
};

function spaceClient(status: "left" | "live" = "live"): SpaceClient {
  return {
    dispose: vi.fn(),
    getSnapshot: vi.fn(() => ({ connection: { status } })),
    leave: vi.fn().mockResolvedValue(undefined),
  } as unknown as SpaceClient;
}

describe("mobile Space client", () => {
  it("constructs the public native client with broker endpoints, arrival defaults, and journey telemetry", () => {
    const client = spaceClient();
    const getAccess = vi.fn() as unknown as GetAccess;
    const journey = {} as TelemetryJourney;
    nativeClientFactory.mockReturnValue(client);

    expect(
      createMobileSpaceClient({
        credential,
        defaults: { camera: false, microphone: true },
        getAccess,
        journey,
        space: "local-space",
      }),
    ).toBe(client);
    expect(nativeClientFactory).toHaveBeenCalledWith({
      baseUrl: credential.apiBaseURL,
      camera: false,
      getAccess,
      microphone: true,
      space: "local-space",
      storage: asyncStorage,
      syncUrl: credential.syncURL,
      telemetry: journey,
    });
  });

  it("leaves and disposes an owned live client exactly once", async () => {
    const client = spaceClient();
    const owner = ownMobileSpaceClient(client);

    await Promise.all([owner.release(), owner.release()]);

    expect(client.leave).toHaveBeenCalledTimes(1);
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not leave a client that has already left, but still disposes it", async () => {
    const client = spaceClient("left");

    await ownMobileSpaceClient(client).release();

    expect(client.leave).not.toHaveBeenCalled();
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it("shares Episode-end and leave cleanup, then permits a retry after a transient failure", async () => {
    const cleanupCredential = vi.fn().mockRejectedValueOnce(new Error("broker unavailable")).mockResolvedValueOnce(undefined);
    const onClose = vi.fn().mockResolvedValue(undefined);
    const onReleaseFailure = vi.fn();
    const release = createMobileSpaceRelease({ cleanupCredential, onClose, onReleaseFailure });

    const first = release(credential);
    expect(release(credential)).toBe(first);
    await expect(first).rejects.toThrow("broker unavailable");

    await expect(release(credential)).resolves.toBeUndefined();
    expect(cleanupCredential).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onReleaseFailure).toHaveBeenCalledOnce();
  });
});
