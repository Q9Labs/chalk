import type { EmitterSubscription } from "react-native";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export type NativeCallKitHandleType = "generic" | "emailAddress" | "phoneNumber";
export type NativeCallKitEndReason = "answeredElsewhere" | "declinedElsewhere" | "failed" | "missed" | "remoteEnded" | "unanswered";

export interface NativeCallKitConfiguration {
  appName?: string;
  iconTemplateImageName?: string;
  includesCallsInRecents?: boolean;
  maximumCallGroups?: number;
  maximumCallsPerCallGroup?: number;
  ringtoneSound?: string;
}

export interface NativeCallKitCallOptions {
  callUUID?: string;
  displayName?: string;
  handle?: string;
  handleType?: NativeCallKitHandleType;
  hasVideo?: boolean;
  supportsDTMF?: boolean;
  supportsGrouping?: boolean;
  supportsHolding?: boolean;
  supportsUngrouping?: boolean;
}

export interface NativeCallKitEndCallOptions {
  callUUID?: string;
  reason?: NativeCallKitEndReason;
}

export type NativeCallKitEvent = { callUUID: string; type: "answerCallAction" } | { callUUID: string; muted: boolean; type: "setMutedCallAction" } | { callUUID: string; type: "endCallAction" } | { type: "audioSessionActivated" } | { type: "audioSessionDeactivated" } | { type: "providerReset" };

type NativeChalkCallKitModule = {
  addListener?: (eventName: string) => void;
  configure: (options: NativeCallKitConfiguration) => Promise<{ isSupported: boolean }>;
  endAllCalls: () => Promise<void>;
  endCall: (options: NativeCallKitEndCallOptions) => Promise<void>;
  eventName?: string;
  isSupported?: boolean;
  removeListeners?: (count: number) => void;
  reportConnected: (options: Pick<NativeCallKitCallOptions, "callUUID">) => Promise<void>;
  reportIncomingCall: (options: NativeCallKitCallOptions) => Promise<{ callUUID: string }>;
  startCall: (options: NativeCallKitCallOptions) => Promise<{ callUUID: string }>;
  updateCall: (options: NativeCallKitCallOptions) => Promise<void>;
};

const moduleName = "ChalkCallKitModule";
const nativeModule = NativeModules[moduleName] as NativeChalkCallKitModule | undefined;
const nativeEventName = nativeModule?.eventName ?? "ChalkCallKitEvent";
const nativeEmitter = nativeModule ? new NativeEventEmitter(nativeModule as ConstructorParameters<typeof NativeEventEmitter>[0]) : null;

function getNativeCallKitModule(): NativeChalkCallKitModule | null {
  if (Platform.OS !== "ios" || nativeModule?.isSupported !== true) {
    return null;
  }

  return nativeModule;
}

function createNoopSubscription(): EmitterSubscription {
  return {
    remove() {
      return undefined;
    },
  } as EmitterSubscription;
}

export const nativeCallKit = {
  addListener(listener: (event: NativeCallKitEvent) => void): EmitterSubscription {
    if (!nativeEmitter) {
      return createNoopSubscription();
    }

    return nativeEmitter.addListener(nativeEventName, listener);
  },
  async configure(options: NativeCallKitConfiguration): Promise<{ isSupported: boolean }> {
    const module = getNativeCallKitModule();
    if (!module) {
      return { isSupported: false };
    }

    return module.configure(options);
  },
  async endAllCalls(): Promise<void> {
    const module = getNativeCallKitModule();
    if (!module) {
      return;
    }

    await module.endAllCalls();
  },
  async endCall(options: NativeCallKitEndCallOptions): Promise<void> {
    const module = getNativeCallKitModule();
    if (!module) {
      return;
    }

    await module.endCall(options);
  },
  isSupported: getNativeCallKitModule() !== null,
  async reportConnected(options: Pick<NativeCallKitCallOptions, "callUUID">): Promise<void> {
    const module = getNativeCallKitModule();
    if (!module) {
      return;
    }

    await module.reportConnected(options);
  },
  async reportIncomingCall(options: NativeCallKitCallOptions): Promise<{ callUUID: string } | null> {
    const module = getNativeCallKitModule();
    if (!module) {
      return null;
    }

    return module.reportIncomingCall(options);
  },
  async startCall(options: NativeCallKitCallOptions): Promise<{ callUUID: string } | null> {
    const module = getNativeCallKitModule();
    if (!module) {
      return null;
    }

    return module.startCall(options);
  },
  async updateCall(options: NativeCallKitCallOptions): Promise<void> {
    const module = getNativeCallKitModule();
    if (!module) {
      return;
    }

    await module.updateCall(options);
  },
};
