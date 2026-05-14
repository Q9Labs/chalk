import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const eventName = "ChalkAndroidConnectionServiceEvent";

export type AndroidConnectionServiceDisconnectReason = "canceled" | "error" | "local" | "missed" | "rejected" | "remote";

export interface AndroidConnectionServiceCall {
  callId: string;
  roomId: string;
  roomName: string;
  displayName: string;
  hasVideo?: boolean;
}

export interface AndroidConnectionServiceDisconnectEvent {
  type: "disconnect";
  callId: string;
  reason: AndroidConnectionServiceDisconnectReason;
}

export interface AndroidConnectionServiceEndCallOptions {
  reason?: AndroidConnectionServiceDisconnectReason;
  label?: string;
}

type AndroidConnectionServiceEvent = AndroidConnectionServiceDisconnectEvent;

interface ChalkAndroidConnectionServiceNativeModule {
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
  endCall: (callId: string, reason?: string, label?: string) => Promise<boolean>;
  isSupported: () => Promise<boolean>;
  registerPhoneAccount: () => Promise<boolean>;
  setActive: (callId: string) => Promise<boolean>;
  startCall: (call: AndroidConnectionServiceCall) => Promise<boolean>;
}

function getNativeModule(): ChalkAndroidConnectionServiceNativeModule | null {
  if (Platform.OS !== "android") {
    return null;
  }

  const nativeModule = NativeModules.ChalkAndroidConnectionService as ChalkAndroidConnectionServiceNativeModule | undefined;
  return nativeModule ?? null;
}

export async function isAndroidConnectionServiceSupported(): Promise<boolean> {
  const nativeModule = getNativeModule();
  if (!nativeModule) {
    return false;
  }

  return nativeModule.isSupported();
}

export async function ensureAndroidConnectionServiceRegistered(): Promise<boolean> {
  const nativeModule = getNativeModule();
  if (!nativeModule) {
    return false;
  }

  return nativeModule.registerPhoneAccount();
}

export async function startAndroidConnectionServiceCall(call: AndroidConnectionServiceCall): Promise<boolean> {
  const nativeModule = getNativeModule();
  if (!nativeModule) {
    return false;
  }

  return nativeModule.startCall(call);
}

export async function setAndroidConnectionServiceActive(callId: string): Promise<boolean> {
  const nativeModule = getNativeModule();
  if (!nativeModule) {
    return false;
  }

  return nativeModule.setActive(callId);
}

export async function endAndroidConnectionServiceCall(callId: string, options: AndroidConnectionServiceEndCallOptions = {}): Promise<boolean> {
  const nativeModule = getNativeModule();
  if (!nativeModule) {
    return false;
  }

  return nativeModule.endCall(callId, options.reason, options.label);
}

export function addAndroidConnectionServiceListener(listener: (event: AndroidConnectionServiceEvent) => void): () => void {
  const nativeModule = getNativeModule();
  if (!nativeModule) {
    return () => {};
  }

  const eventEmitter = new NativeEventEmitter(nativeModule);
  const subscription = eventEmitter.addListener(eventName, (payload: AndroidConnectionServiceEvent) => {
    listener(payload);
  });

  return () => {
    subscription.remove();
  };
}
