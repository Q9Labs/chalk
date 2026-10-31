import { expect, expectTypeOf, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

it("synchronously forwards audio observation to the current media port with a no-op before join", async () => {
  const platform = createCoreTestPlatform();
  const handle = { played: vi.fn(), detach: vi.fn() };
  const observeAudioElement = vi.fn(() => handle);
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => opaqueAccessGrant("audio") }, { ...platform, dependencies: { ...platform.dependencies, createMediaClient: (input) => ({ ...platform.dependencies.createMediaClient(input), observeAudioElement }) } });
  const track = {} as MediaStreamTrack;
  const element = {} as HTMLAudioElement;
  try {
    const absent = client.media.observeAudioElement(track, element);
    expectTypeOf(absent).toEqualTypeOf<{ played(result: unknown): void; detach(): void }>();
    absent.played(undefined);
    absent.detach();
    expect(observeAudioElement).not.toHaveBeenCalled();
    await client.join({ microphone: false, camera: false });
    expect(client.media.observeAudioElement(track, element)).toBe(handle);
    expect(observeAudioElement).toHaveBeenCalledWith(track, element);
  } finally {
    client.dispose();
  }
});
