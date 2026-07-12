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

describe("RealtimeKit loader", () => {
  beforeEach(() => {
    vi.resetModules();
    realtimeKitModule.init.mockReset();
    realtimeKitModule.init.mockImplementation(async (config: unknown) => config);
    realtimeKitModule.initMedia.mockReset();
    realtimeKitModule.initMedia.mockImplementation(async () => ({ shouldNotBeUsed: true }));
  });

  it("keeps simulator joins media-off without eagerly initializing local media", async () => {
    const { importReactNativeRealtimeKit } = await import("./loader");
    const realtimeKit = await importReactNativeRealtimeKit();
    const result = await realtimeKit.init({
      defaults: { customFlag: true },
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

  it("observes and releases the peer connection configured by its RealtimeKit transport", async () => {
    const { RTCPeerConnection } = await import("@cloudflare/react-native-webrtc");
    const peerConnection = new RTCPeerConnection();
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
    const { createLoader } = await import("./loader");
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const observer = vi.fn(() => {
      const cleanup = vi.fn();
      cleanups.push(cleanup);
      return cleanup;
    });
    const loader = createLoader(observer);
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

  it("observes a peer connection created after an asynchronous join without observing unrelated connections", async () => {
    const { RTCPeerConnection } = await import("@cloudflare/react-native-webrtc");
    let releaseJoin: (() => void) | undefined;
    const joinBlocked = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    let markJoinStarted: (() => void) | undefined;
    const joinStarted = new Promise<void>((resolve) => {
      markJoinStarted = resolve;
    });
    const configureSendTransport = vi.fn();
    const callStats = { configureSendTransport };
    const client = {
      __internals__: { callStats },
      join: () => {
        markJoinStarted?.();
        return joinBlocked.then(() => {
          const peerConnection = new RTCPeerConnection();
          callStats.configureSendTransport({ handler: { pc: peerConnection } });
          return peerConnection;
        });
      },
    };

    realtimeKitModule.init.mockImplementationOnce(async () => client);
    const { createLoader } = await import("./loader");
    const observer = vi.fn();
    const loader = createLoader(observer);
    const realtimeKit = await loader();
    const initializedClient = await realtimeKit.init({});
    const peerConnectionPromise = initializedClient.join();

    await joinStarted;
    const unrelatedPeerConnection = new RTCPeerConnection();
    expect(observer).not.toHaveBeenCalled();
    if (!releaseJoin) throw new Error("Join release was not initialized");
    releaseJoin();

    const observedPeerConnection = await peerConnectionPromise;
    expect(observer).toHaveBeenCalledExactlyOnceWith(observedPeerConnection);
    expect(observer).not.toHaveBeenCalledWith(unrelatedPeerConnection);

    loader.dispose();
  });

  it("keeps overlapping RealtimeKit transports attributed to their owner", async () => {
    const { RTCPeerConnection } = await import("@cloudflare/react-native-webrtc");
    const firstConfigureSendTransport = vi.fn();
    const secondConfigureRecvTransport = vi.fn();
    const firstClient = {
      __internals__: { callStats: { configureSendTransport: firstConfigureSendTransport } },
      join: () => {
        const peerConnection = new RTCPeerConnection();
        firstClient.__internals__.callStats.configureSendTransport({ handler: { pc: peerConnection } });
        return peerConnection;
      },
    };
    const secondClient = {
      __internals__: { callStats: { configureRecvTransport: secondConfigureRecvTransport } },
      joinRoom: () => {
        const peerConnection = new RTCPeerConnection();
        secondClient.__internals__.callStats.configureRecvTransport({ handler: { pc: peerConnection } });
        return peerConnection;
      },
    };

    realtimeKitModule.init.mockImplementation(async (config: { owner: string }) => (config.owner === "first" ? firstClient : secondClient));
    const { createLoader } = await import("./loader");
    const firstObserver = vi.fn();
    const secondObserver = vi.fn();
    const firstLoader = createLoader(firstObserver);
    const secondLoader = createLoader(secondObserver);
    const [firstRealtimeKit, secondRealtimeKit] = await Promise.all([firstLoader(), secondLoader()]);
    const firstClientInstance = await firstRealtimeKit.init({ owner: "first" });
    const secondClientInstance = await secondRealtimeKit.init({ owner: "second" });
    const firstPeerConnection = firstClientInstance.join();
    const secondPeerConnection = secondClientInstance.joinRoom();

    expect(firstObserver).toHaveBeenCalledExactlyOnceWith(firstPeerConnection);
    expect(secondObserver).toHaveBeenCalledExactlyOnceWith(secondPeerConnection);
    expect(firstObserver).not.toHaveBeenCalledWith(secondPeerConnection);
    expect(secondObserver).not.toHaveBeenCalledWith(firstPeerConnection);

    firstLoader.dispose();
    secondLoader.dispose();
    expect(firstClient.__internals__.callStats.configureSendTransport).toBe(firstConfigureSendTransport);
    expect(secondClient.__internals__.callStats.configureRecvTransport).toBe(secondConfigureRecvTransport);
  });
});
