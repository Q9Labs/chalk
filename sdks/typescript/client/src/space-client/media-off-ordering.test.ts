import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionMediaFactoryInput } from "../connection/dependencies";
import { joinWithTerminalControl, observeMicrophonePublication, terminalTestClient, terminalTestPlatform } from "./terminal.test.helpers";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const base = terminalTestPlatform();
  const closing = Promise.withResolvers<void>();
  const closeForcedLocalPublication = vi.fn(() => closing.promise);
  const sync = base.dependencies.createSyncClient();
  const setMicrophoneEnabled = vi.fn(sync.setMicrophoneEnabled);
  const platform = {
    ...base,
    dependencies: {
      ...base.dependencies,
      createSyncClient: () => ({ ...sync, setMicrophoneEnabled }),
      createMediaClient: (input: ConnectionMediaFactoryInput) => ({ ...base.dependencies.createMediaClient(input), closeForcedLocalPublication }),
    },
  };
  return { platform, closing, closeForcedLocalPublication, setMicrophoneEnabled, ...terminalTestClient(platform) };
}

async function joinWithMicrophone(test: ReturnType<typeof fixture>) {
  await joinWithTerminalControl(test.client, test.platform);
  observeMicrophonePublication(test.platform, Object.assign(new EventTarget(), { kind: "audio", enabled: true, readyState: "live", stop: () => undefined }) as unknown as MediaStreamTrack);
}

it("tells Sync about a microphone off while the SFU close is still in flight", async () => {
  const test = fixture();
  try {
    await joinWithMicrophone(test);
    const turningOff = test.client.media.setMicrophoneEnabled(false);
    await vi.waitFor(() => expect(test.closeForcedLocalPublication).toHaveBeenCalledWith("microphone", "user_pause"));
    await vi.waitFor(() => expect(test.setMicrophoneEnabled).toHaveBeenCalledWith(false));

    let settled = false;
    void turningOff.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    test.closing.resolve();
    await turningOff;
  } finally {
    test.client.dispose();
  }
});

it("reports a failed SFU close after Sync has the off", async () => {
  const test = fixture();
  try {
    await joinWithMicrophone(test);
    const turningOff = test.client.media.setMicrophoneEnabled(false);
    const outcome = turningOff.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(test.setMicrophoneEnabled).toHaveBeenCalledWith(false));
    test.closing.reject(new Error("tracks/close failed"));
    await expect(outcome).resolves.toBe("rejected");
  } finally {
    test.client.dispose();
  }
});
