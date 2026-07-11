import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModules = {
  ChalkRuntimeInfo: { isSimulator: true },
  WebRTCModule: {
    receiverGetCapabilities: vi.fn(() => ({ codecs: [], headerExtensions: [] })),
    senderGetCapabilities: vi.fn(() => ({ codecs: [], headerExtensions: [] })),
  },
};

const realtimeKitModule = {
  init: vi.fn(async (config: unknown) => config),
  initMedia: vi.fn(async () => ({ shouldNotBeUsed: true })),
};

vi.mock("react-native", () => ({
  NativeModules: nativeModules,
  Platform: { OS: "ios" },
}));

vi.mock("@cloudflare/react-native-webrtc", () => ({
  RTCPeerConnection: class {
    addEventListener() {}
    getStats = async () => new Map();
    removeEventListener() {}
  },
  RTCRtpReceiver: {
    getCapabilities: vi.fn(() => ({ codecs: [], headerExtensions: [] })),
  },
  RTCRtpSender: {
    getCapabilities: vi.fn(() => ({ codecs: [], headerExtensions: [] })),
  },
  mediaDevices: {
    enumerateDevices: vi.fn(async () => [{ kind: "videoinput", deviceId: "camera-1" }]),
  },
}));

vi.mock("@cloudflare/realtimekit-react-native", () => ({
  default: realtimeKitModule,
}));

describe("importReactNativeRealtimeKit", () => {
  beforeEach(() => {
    vi.resetModules();
    realtimeKitModule.init.mockReset();
    realtimeKitModule.init.mockImplementation(async (config: unknown) => config);
    realtimeKitModule.initMedia.mockReset();
    realtimeKitModule.initMedia.mockImplementation(async () => ({ shouldNotBeUsed: true }));
  });

  it("keeps simulator joins media-off without eagerly initializing local media", async () => {
    const { importReactNativeRealtimeKit } = await import("./realtimekit-loader");

    const realtimeKit = await importReactNativeRealtimeKit();
    const result = await realtimeKit.init({
      defaults: {
        customFlag: true,
      },
    });

    expect(realtimeKitModule.initMedia).not.toHaveBeenCalled();
    expect(realtimeKitModule.init).toHaveBeenCalledWith({
      defaults: {
        customFlag: true,
        audio: false,
        video: false,
      },
    });
    expect(result).toEqual({
      defaults: {
        customFlag: true,
        audio: false,
        video: false,
      },
    });
  });

  it("observes the peer connection configured by its RealtimeKit transport and preserves the client", async () => {
    const nativeWebRtc = (await import("@cloudflare/react-native-webrtc")) as unknown as {
      RTCPeerConnection: new () => unknown;
    };
    const peerConnection = new nativeWebRtc.RTCPeerConnection();
    let configureThis: unknown;
    const configureSendTransport = vi.fn(function (this: unknown) {
      configureThis = this;
    });
    const configureRecvTransport = vi.fn();
    const callStats = { configureSendTransport, configureRecvTransport };

    class RealtimeKitClient {
      readonly #label = "client-private-state";
      readonly __internals__ = { callStats };

      get label() {
        return this.#label;
      }

      async join() {
        this.__internals__.callStats.configureSendTransport({ handler: { pc: peerConnection } });
        return peerConnection;
      }

      leave() {
        return this.#label;
      }
    }

    realtimeKitModule.init.mockImplementationOnce(async () => new RealtimeKitClient());
    const { createOwnedNativeRealtimeKitLoader } = await import("./realtimekit-loader");
    const cleanups: ReturnType<typeof vi.fn>[] = [];
    const observer = vi.fn(() => {
      const cleanup = vi.fn();
      cleanups.push(cleanup);
      return cleanup;
    });
    const loader = createOwnedNativeRealtimeKitLoader(observer);
    const realtimeKit = await loader();
    const client = await realtimeKit.init({});

    expect(client).toBeInstanceOf(RealtimeKitClient);
    expect(client.label).toBe("client-private-state");
    expect(client.leave()).toBe("client-private-state");
    expect(await client.join()).toBe(peerConnection);
    expect(observer).toHaveBeenCalledExactlyOnceWith(peerConnection);
    expect(configureSendTransport).toHaveBeenCalledExactlyOnceWith({ handler: { pc: peerConnection } });
    expect(configureThis).toBe(callStats);

    loader.dispose();
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]).toHaveBeenCalledExactlyOnceWith();
    expect(callStats.configureSendTransport).toBe(configureSendTransport);
    expect(callStats.configureRecvTransport).toBe(configureRecvTransport);
  });

  it("observes a delayed RealtimeKit transport peer connection without observing unrelated connections", async () => {
    const nativeWebRtc = (await import("@cloudflare/react-native-webrtc")) as unknown as {
      RTCPeerConnection: new () => unknown;
    };
    let releaseJoin!: () => void;
    const joinBlocked = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    let markJoinStarted!: () => void;
    const joinStarted = new Promise<void>((resolve) => {
      markJoinStarted = resolve;
    });
    let delayedPeerConnection!: unknown;
    const configureSendTransport = vi.fn();
    const callStats = { configureSendTransport };
    const client = {
      __internals__: { callStats },
      join: () => {
        markJoinStarted();
        return joinBlocked.then(() => {
          delayedPeerConnection = new nativeWebRtc.RTCPeerConnection();
          callStats.configureSendTransport({ handler: { pc: delayedPeerConnection } });
          return delayedPeerConnection;
        });
      },
    };

    realtimeKitModule.init.mockImplementationOnce(async () => client);
    const { createOwnedNativeRealtimeKitLoader } = await import("./realtimekit-loader");
    const observer = vi.fn();
    const loader = createOwnedNativeRealtimeKitLoader(observer);
    const realtimeKit = await loader();
    const initializedClient = await realtimeKit.init({});

    const delayedPeerConnectionPromise = initializedClient.join();
    await joinStarted;
    const unrelatedPeerConnection = new nativeWebRtc.RTCPeerConnection();
    expect(observer).not.toHaveBeenCalled();

    releaseJoin();
    expect(await delayedPeerConnectionPromise).toBe(delayedPeerConnection);
    expect(observer).toHaveBeenCalledExactlyOnceWith(delayedPeerConnection);
    expect(observer.mock.calls.flat()).not.toContain(unrelatedPeerConnection);

    loader.dispose();
  });

  it("attributes delayed peer connections from overlapping RealtimeKit joins to their matching observers", async () => {
    const nativeWebRtc = (await import("@cloudflare/react-native-webrtc")) as unknown as {
      RTCPeerConnection: new () => unknown;
    };
    let releaseFirstJoin!: () => void;
    const firstJoinBlocked = new Promise<void>((resolve) => {
      releaseFirstJoin = resolve;
    });
    let releaseSecondJoin!: () => void;
    const secondJoinBlocked = new Promise<void>((resolve) => {
      releaseSecondJoin = resolve;
    });
    let markFirstJoinStarted!: () => void;
    const firstJoinStarted = new Promise<void>((resolve) => {
      markFirstJoinStarted = resolve;
    });
    let markSecondJoinStarted!: () => void;
    const secondJoinStarted = new Promise<void>((resolve) => {
      markSecondJoinStarted = resolve;
    });
    let firstPeerConnection!: unknown;
    let secondPeerConnection!: unknown;
    const firstConfigureSendTransport = vi.fn();
    const secondConfigureRecvTransport = vi.fn();
    const firstCallStats = { configureSendTransport: firstConfigureSendTransport };
    const secondCallStats = { configureRecvTransport: secondConfigureRecvTransport };
    const firstClient = {
      __internals__: { callStats: firstCallStats },
      join: () => {
        markFirstJoinStarted();
        return firstJoinBlocked.then(() => {
          firstPeerConnection = new nativeWebRtc.RTCPeerConnection();
          firstCallStats.configureSendTransport({ handler: { pc: firstPeerConnection } });
          return firstPeerConnection;
        });
      },
    };
    const secondClient = {
      __internals__: { callStats: secondCallStats },
      joinRoom: () => {
        markSecondJoinStarted();
        return secondJoinBlocked.then(() => {
          secondPeerConnection = new nativeWebRtc.RTCPeerConnection();
          secondCallStats.configureRecvTransport({ handler: { pc: secondPeerConnection } });
          return secondPeerConnection;
        });
      },
    };

    realtimeKitModule.init.mockImplementation(async (config: { owner: string }) => (config.owner === "first" ? firstClient : secondClient));
    const { createOwnedNativeRealtimeKitLoader } = await import("./realtimekit-loader");
    const firstObserver = vi.fn();
    const secondObserver = vi.fn();
    const firstLoader = createOwnedNativeRealtimeKitLoader(firstObserver);
    const secondLoader = createOwnedNativeRealtimeKitLoader(secondObserver);
    const [firstRealtimeKit, secondRealtimeKit] = await Promise.all([firstLoader(), secondLoader()]);
    const firstInitializedClient = await firstRealtimeKit.init({ owner: "first" });
    const secondInitializedClient = await secondRealtimeKit.init({ owner: "second" });

    const firstPeerConnectionPromise = firstInitializedClient.join();
    const secondPeerConnectionPromise = secondInitializedClient.joinRoom();
    await Promise.all([firstJoinStarted, secondJoinStarted]);
    const unrelatedPeerConnection = new nativeWebRtc.RTCPeerConnection();
    expect(firstObserver).not.toHaveBeenCalled();
    expect(secondObserver).not.toHaveBeenCalled();

    releaseSecondJoin();
    releaseFirstJoin();
    const [firstObservedPeerConnection, secondObservedPeerConnection] = await Promise.all([firstPeerConnectionPromise, secondPeerConnectionPromise]);

    expect(firstObserver).toHaveBeenCalledExactlyOnceWith(firstObservedPeerConnection);
    expect(secondObserver).toHaveBeenCalledExactlyOnceWith(secondObservedPeerConnection);
    expect(firstObserver.mock.calls.flat()).not.toContain(secondObservedPeerConnection);
    expect(secondObserver.mock.calls.flat()).not.toContain(firstObservedPeerConnection);
    expect(firstObserver.mock.calls.flat()).not.toContain(unrelatedPeerConnection);
    expect(secondObserver.mock.calls.flat()).not.toContain(unrelatedPeerConnection);

    firstLoader.dispose();
    secondLoader.dispose();
    expect(firstCallStats.configureSendTransport).toBe(firstConfigureSendTransport);
    expect(secondCallStats.configureRecvTransport).toBe(secondConfigureRecvTransport);
  });
});
