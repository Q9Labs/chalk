import realtimeKitModule from "@cloudflare/realtimekit-react-native";
import * as reactNativeWebRtc from "@cloudflare/react-native-webrtc";
import type { MediaPlaneLoader, MediaPlaneObserver } from "../media-plane-port";
import { ensureIosSimulatorWebRtcSafety, isIosSimulator } from "../../utils/ios-simulator";

export type NativeRealtimeKit = typeof realtimeKitModule;
export type NativePeerConnectionObserver = MediaPlaneObserver;
export type RealtimeKitLoader = MediaPlaneLoader<NativeRealtimeKit>;

export interface OwnedNativeRealtimeKitLoader extends MediaPlaneLoader<NativeRealtimeKit> {
  dispose(): void;
}

type RealtimeKitTransportConfigurationMethod = "configureSendTransport" | "configureRecvTransport";
type RealtimeKitTransportConfigurator = (transport: unknown, ...args: unknown[]) => unknown;
type RealtimeKitCallStats = Partial<Record<RealtimeKitTransportConfigurationMethod, RealtimeKitTransportConfigurator>>;

interface NativePeerConnectionObserverRegistration {
  readonly boundCallStats: WeakSet<RealtimeKitCallStats>;
  readonly cleanups: Set<() => void>;
  readonly observedPeerConnections: WeakSet<Parameters<MediaPlaneObserver>[0]>;
  readonly observer: MediaPlaneObserver;
  disposed: boolean;
}

/** Loads RealtimeKit and binds each transport peer connection to one observer. */
export function createLoader(observer: MediaPlaneObserver): OwnedNativeRealtimeKitLoader {
  const registration: NativePeerConnectionObserverRegistration = {
    observer,
    cleanups: new Set(),
    observedPeerConnections: new WeakSet(),
    boundCallStats: new WeakSet(),
    disposed: false,
  };

  const loader = async (): Promise<NativeRealtimeKit> => {
    const realtimeKit = await importReactNativeRealtimeKit();
    return registration.disposed ? realtimeKit : bindRealtimeKitOwner(realtimeKit, registration);
  };

  loader.dispose = (): void => {
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

export async function importReactNativeRealtimeKit(): Promise<NativeRealtimeKit> {
  if (!isIosSimulator()) {
    return realtimeKitModule;
  }

  // Keep native modules on Metro's main bundle path so Expo simulator builds do
  // not fall back to async-require before HMR initialization.
  ensureIosSimulatorWebRtcSafety(reactNativeWebRtc);
  ensureIosSimulatorWebRtcSafety();

  return new Proxy(realtimeKitModule, {
    get(target, property, receiver): unknown {
      if (property !== "init") return Reflect.get(target, property, receiver);

      return (config: Parameters<NativeRealtimeKit["init"]>[0]) =>
        target.init({
          ...config,
          defaults: {
            ...config.defaults,
            audio: false,
            video: false,
          },
        });
    },
  });
}

function bindRealtimeKitOwner(realtimeKit: NativeRealtimeKit, registration: NativePeerConnectionObserverRegistration): NativeRealtimeKit {
  const init = realtimeKit.init;

  return new Proxy(realtimeKit, {
    get(target, property, receiver): unknown {
      if (property !== "init") return Reflect.get(target, property, receiver);

      return (...args: Parameters<typeof init>) => init(...args).then((client) => bindRealtimeKitClientOwner(client, registration));
    },
  });
}

function bindRealtimeKitClientOwner(client: unknown, registration: NativePeerConnectionObserverRegistration): unknown {
  if (registration.disposed || !isRecord(client) || !isRecord(client.__internals__) || !isRealtimeKitCallStats(client.__internals__.callStats)) {
    return client;
  }

  const callStats = client.__internals__.callStats;
  if (registration.boundCallStats.has(callStats)) return client;

  registration.boundCallStats.add(callStats);
  bindTransportConfigurator(callStats, "configureSendTransport", registration);
  bindTransportConfigurator(callStats, "configureRecvTransport", registration);

  return client;
}

function bindTransportConfigurator(callStats: RealtimeKitCallStats, method: RealtimeKitTransportConfigurationMethod, registration: NativePeerConnectionObserverRegistration): void {
  const configureTransport = callStats[method];
  if (typeof configureTransport !== "function") return;

  const configureTransportWithObservation = function (this: unknown, transport: unknown, ...args: unknown[]): unknown {
    observeOwnedTransport(registration, transport);
    return Reflect.apply(configureTransport, this, [transport, ...args]);
  };
  callStats[method] = configureTransportWithObservation;

  registration.cleanups.add(() => {
    if (callStats[method] === configureTransportWithObservation) callStats[method] = configureTransport;
  });
}

function observeOwnedTransport(registration: NativePeerConnectionObserverRegistration, transport: unknown): void {
  const peerConnection = peerConnectionFromTransport(transport);
  if (!peerConnection || registration.disposed || registration.observedPeerConnections.has(peerConnection)) return;

  try {
    const cleanup = registration.observer(peerConnection);
    registration.observedPeerConnections.add(peerConnection);
    if (typeof cleanup === "function") registration.cleanups.add(cleanup);
  } catch {
    // Diagnostics observation must never prevent RealtimeKit from connecting.
  }
}

function peerConnectionFromTransport(transport: unknown): Parameters<MediaPlaneObserver>[0] | undefined {
  if (!isRecord(transport) || !isRecord(transport.handler)) return undefined;

  const peerConnection = transport.handler.pc;
  if (!isNativePeerConnection(peerConnection)) return undefined;

  return peerConnection;
}

function isNativePeerConnection(value: unknown): value is Parameters<MediaPlaneObserver>[0] {
  return isRecord(value) && typeof value.addEventListener === "function" && typeof value.getStats === "function" && typeof value.removeEventListener === "function";
}

function isRealtimeKitCallStats(value: unknown): value is RealtimeKitCallStats {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
