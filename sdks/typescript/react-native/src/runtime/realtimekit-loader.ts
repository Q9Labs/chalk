import realtimeKitModule from "@cloudflare/realtimekit-react-native";
import * as reactNativeWebRtc from "@cloudflare/react-native-webrtc";
import type { NativeRtcPeerConnection } from "../telemetry";
import { ensureIosSimulatorWebRtcSafety, isIosSimulator } from "../utils/ios-simulator";

type NativePeerConnectionObserver = (peerConnection: NativeRtcPeerConnection) => void | (() => void);
type RealtimeKitTransport = { readonly handler?: { readonly pc?: NativeRtcPeerConnection } };
type RealtimeKitTransportConfigurator = (transport: RealtimeKitTransport) => unknown;
type RealtimeKitTransportConfigurationMethod = "configureSendTransport" | "configureRecvTransport";
type RealtimeKitCallStats = Partial<Record<RealtimeKitTransportConfigurationMethod, RealtimeKitTransportConfigurator>>;
type RealtimeKitClient = { readonly __internals__?: { readonly callStats?: RealtimeKitCallStats } };

export interface OwnedNativeRealtimeKitLoader {
  (): Promise<any>;
  dispose(): void;
}

interface NativePeerConnectionObserverRegistration {
  readonly observer: NativePeerConnectionObserver;
  readonly cleanups: Set<() => void>;
  readonly observedPeerConnections: WeakSet<NativeRtcPeerConnection>;
  readonly boundCallStats: WeakSet<RealtimeKitCallStats>;
  disposed: boolean;
}

/** Binds RealtimeKit transport peer connections to one session observer. */
export function createOwnedNativeRealtimeKitLoader(observer: NativePeerConnectionObserver): OwnedNativeRealtimeKitLoader {
  const registration: NativePeerConnectionObserverRegistration = {
    observer,
    cleanups: new Set(),
    observedPeerConnections: new WeakSet(),
    boundCallStats: new WeakSet(),
    disposed: false,
  };

  const loader = async () => {
    const realtimeKit = await importReactNativeRealtimeKit();
    return registration.disposed ? realtimeKit : bindRealtimeKitOwner(realtimeKit, registration);
  };

  loader.dispose = () => {
    if (registration.disposed) return;
    registration.disposed = true;

    for (const cleanup of registration.cleanups) {
      try {
        cleanup();
      } catch {
        // Diagnostics cleanup must not interfere with the native call lifecycle.
      }
    }
    registration.cleanups.clear();
  };

  return loader;
}

export const importReactNativeRealtimeKit = async () => {
  if (isIosSimulator()) {
    // Keep the RN native modules on the main Metro bundle path.
    // In Expo dev-client / simulator flows, dynamic `import()` here can fall back
    // to async-require and trip "Expected HMRClient.setup() call at startup."
    ensureIosSimulatorWebRtcSafety(reactNativeWebRtc);
  }

  const realtimeKit = realtimeKitModule as any;

  if (!isIosSimulator()) {
    return realtimeKit;
  }

  ensureIosSimulatorWebRtcSafety();

  return {
    ...realtimeKit,
    init: async (config: any) => {
      return realtimeKit.init({
        ...config,
        defaults: {
          ...(config?.defaults ?? {}),
          audio: false,
          video: false,
        },
      });
    },
  } as any;
};

function bindRealtimeKitOwner(realtimeKit: any, registration: NativePeerConnectionObserverRegistration): any {
  const init = realtimeKit.init;
  return new Proxy(realtimeKit, {
    get(target, property, receiver) {
      if (property !== "init" || typeof init !== "function") return Reflect.get(target, property, receiver);
      return (...args: any[]) => Promise.resolve(Reflect.apply(init, target, args)).then((client) => bindRealtimeKitClientOwner(client, registration));
    },
  });
}

function bindRealtimeKitClientOwner(client: unknown, registration: NativePeerConnectionObserverRegistration): unknown {
  if (!client || (typeof client !== "object" && typeof client !== "function") || registration.disposed) return client;

  const callStats = (client as RealtimeKitClient).__internals__?.callStats;
  if (!callStats || registration.boundCallStats.has(callStats)) return client;

  registration.boundCallStats.add(callStats);
  bindTransportConfigurator(callStats, "configureSendTransport", registration);
  bindTransportConfigurator(callStats, "configureRecvTransport", registration);

  return client;
}

function bindTransportConfigurator(callStats: RealtimeKitCallStats, method: RealtimeKitTransportConfigurationMethod, registration: NativePeerConnectionObserverRegistration): void {
  const configureTransport = callStats[method];
  if (typeof configureTransport !== "function") return;

  const configureTransportWithObservation = function (this: unknown, transport: RealtimeKitTransport, ...args: unknown[]) {
    observeOwnedTransport(registration, transport);
    return Reflect.apply(configureTransport, this, [transport, ...args]);
  };
  callStats[method] = configureTransportWithObservation;

  registration.cleanups.add(() => {
    if (callStats[method] === configureTransportWithObservation) callStats[method] = configureTransport;
  });
}

function observeOwnedTransport(registration: NativePeerConnectionObserverRegistration, transport: RealtimeKitTransport): void {
  const peerConnection = transport.handler?.pc;
  if (!peerConnection || registration.disposed || registration.observedPeerConnections.has(peerConnection)) return;

  try {
    const cleanup = registration.observer(peerConnection);
    registration.observedPeerConnections.add(peerConnection);
    if (typeof cleanup === "function") registration.cleanups.add(cleanup);
  } catch {
    // Diagnostics observation must never prevent RealtimeKit from connecting.
  }
}
