import type { GetAccess, SpaceClient, SpaceClientOptions } from "@q9labsai/chalk-client";
import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import { describe, expect, it, vi } from "vitest";

import { createLocalSpaceClient, createLocalSpaceRelease } from "./local-space-client";

const credential = {
  apiBaseURL: "https://api.chalk.test",
  syncURL: "wss://sync.chalk.test/v1/sync",
};

describe("local Space client", () => {
  it("uses the broker-selected API and sync endpoints with the stable access provider", () => {
    const getAccess = vi.fn<GetAccess>();
    const client = fakeSpaceClient();
    const createSpaceClient = vi.fn<(_: SpaceClientOptions, __: SpaceClientPlatform) => SpaceClient>(() => client);
    const operationJourney = journey();

    createLocalSpaceClient({ credential, getAccess, journey: operationJourney }, { createSpaceClient });

    expect(createSpaceClient).toHaveBeenCalledWith({ space: "local-space", getAccess, baseUrl: credential.apiBaseURL }, { syncUrl: credential.syncURL, telemetry: operationJourney.context });
  });

  it("records SDK client operations on the page journey", async () => {
    const { client: instrumented, recordDiagnostic } = instrumentedSpaceClient();

    await instrumented.media.setMicrophoneEnabled(true);

    expect(recordDiagnostic).toHaveBeenCalledWith({
      category: "connection",
      code: "space.client_operation",
      phase: "media",
      state: "succeeded",
      attributes: { operation: "media.setMicrophoneEnabled", duration_ms: 0 },
    });
  });

  it("records failed SDK client operations on that same journey", async () => {
    const failure = new Error("leave failed");
    const client = fakeSpaceClient({ leave: vi.fn(async () => Promise.reject(failure)) });
    const { client: instrumented, recordDiagnostic } = instrumentedSpaceClient(client);

    await expect(instrumented.leave()).rejects.toThrow(failure);

    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ state: "failed", attributes: { operation: "leave", duration_ms: 0 } }));
  });

  it("releases transport, disposal, and broker cleanup exactly once", async () => {
    const leave = vi.fn(async () => Promise.reject(new Error("already left")));
    const dispose = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const release = createLocalSpaceRelease({ leave, dispose }, cleanup);

    await Promise.all([release(), release()]);

    expect(leave).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("deduplicates an in-flight release and retries broker cleanup after rejection", async () => {
    let rejectCleanup: ((cause: Error) => void) | undefined;
    const leave = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const cleanup = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCleanup = reject;
        }),
    );
    const release = createLocalSpaceRelease({ leave, dispose }, cleanup);

    const first = release();
    expect(release()).toBe(first);
    await Promise.resolve();
    rejectCleanup?.(new Error("broker unavailable"));
    await expect(first).rejects.toThrow("broker unavailable");

    cleanup.mockResolvedValueOnce(undefined);
    await expect(release()).resolves.toBeUndefined();
    expect(leave).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});

function journey() {
  return {
    context: {
      journeyId: "journey",
      rootJourneyId: "journey",
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      tracestate: "chalk=web",
    },
    recordDiagnostic: vi.fn(),
  };
}

function instrumentedSpaceClient(client = fakeSpaceClient()) {
  const recordDiagnostic = vi.fn();
  return {
    client: createLocalSpaceClient({ credential, getAccess: vi.fn<GetAccess>(), journey: { context: journey().context, recordDiagnostic } }, { createSpaceClient: () => client, now: () => 100 }),
    recordDiagnostic,
  };
}

function fakeSpaceClient(overrides: Partial<Pick<SpaceClient, "leave">> = {}): SpaceClient {
  return {
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(),
    endEpisode: vi.fn(async () => undefined),
    extendEpisode: vi.fn(async () => undefined),
    on: vi.fn(() => () => undefined),
    media: {
      setMicrophoneEnabled: vi.fn(async () => undefined),
      setCameraEnabled: vi.fn(async () => undefined),
      setScreenShareEnabled: vi.fn(async () => undefined),
      selectMicrophone: vi.fn(async () => undefined),
      selectCamera: vi.fn(async () => undefined),
      selectSpeaker: vi.fn(async () => undefined),
      acceptRequest: vi.fn(async () => undefined),
      declineRequest: vi.fn(async () => undefined),
    },
    chat: {
      files: { upload: vi.fn(async () => ({})), url: vi.fn(() => "") },
      send: vi.fn(async () => ({})),
      loadOlder: vi.fn(async () => ({})),
      markRead: vi.fn(async () => null),
    },
    participants: {
      assignRole: vi.fn(async () => undefined),
      mute: vi.fn(async () => undefined),
      stopVideo: vi.fn(async () => undefined),
      stopScreenShare: vi.fn(async () => undefined),
      requestMedia: vi.fn(async () => ({})),
      remove: vi.fn(async () => undefined),
      admit: vi.fn(async () => undefined),
      deny: vi.fn(async () => undefined),
      raiseHand: vi.fn(async () => undefined),
      lowerHand: vi.fn(async () => undefined),
      renameSelf: vi.fn(async () => undefined),
    },
    reactions: { send: vi.fn(async () => ({})) },
    whiteboard: { transport: vi.fn(() => null) },
    ...overrides,
  } as unknown as SpaceClient;
}
