import type { EmitterSubscription } from "react-native";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export type CallKitHandleType = "generic" | "emailAddress" | "phoneNumber";
export type CallKitEndReason = "answeredElsewhere" | "declinedElsewhere" | "failed" | "missed" | "remoteEnded" | "unanswered";

export interface CallKitConfiguration {
  appName?: string;
  iconTemplateImageName?: string;
  includesCallsInRecents?: boolean;
  maximumCallGroups?: number;
  maximumCallsPerCallGroup?: number;
  ringtoneSound?: string;
}

export interface CallKitCallOptions {
  callUUID?: string;
  displayName?: string;
  handle?: string;
  handleType?: CallKitHandleType;
  hasVideo?: boolean;
  supportsDTMF?: boolean;
  supportsGrouping?: boolean;
  supportsHolding?: boolean;
  supportsUngrouping?: boolean;
}

export interface CallKitEndCallOptions {
  callUUID?: string;
  reason?: CallKitEndReason;
}

export type CallKitEvent = { callUUID: string; type: "answerCallAction" } | { callUUID: string; muted: boolean; type: "setMutedCallAction" } | { callUUID: string; type: "endCallAction" } | { type: "audioSessionActivated" } | { type: "audioSessionDeactivated" } | { type: "providerReset" };

type NativeChalkCallKitModule = {
  addListener?: (eventName: string) => void;
  configure: (options: CallKitConfiguration) => Promise<{ isSupported: boolean }>;
  endAllCalls: () => Promise<void>;
  endCall: (options: CallKitEndCallOptions) => Promise<void>;
  eventName?: string;
  isSupported?: boolean;
  removeListeners?: (count: number) => void;
  reportConnected: (options: Pick<CallKitCallOptions, "callUUID">) => Promise<void>;
  reportIncomingCall: (options: CallKitCallOptions) => Promise<{ callUUID: string }>;
  startCall: (options: CallKitCallOptions) => Promise<{ callUUID: string }>;
  updateCall: (options: CallKitCallOptions) => Promise<void>;
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

export const callKit = {
  addListener(listener: (event: CallKitEvent) => void): EmitterSubscription {
    if (!nativeEmitter) {
      return createNoopSubscription();
    }

    return nativeEmitter.addListener(nativeEventName, listener);
  },
  async configure(options: CallKitConfiguration): Promise<{ isSupported: boolean }> {
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
  async endCall(options: CallKitEndCallOptions): Promise<void> {
    const module = getNativeCallKitModule();
    if (!module) {
      return;
    }

    await module.endCall(options);
  },
  isSupported: getNativeCallKitModule() !== null,
  async reportConnected(options: Pick<CallKitCallOptions, "callUUID">): Promise<void> {
    const module = getNativeCallKitModule();
    if (!module) {
      return;
    }

    await module.reportConnected(options);
  },
  async reportIncomingCall(options: CallKitCallOptions): Promise<{ callUUID: string } | null> {
    const module = getNativeCallKitModule();
    if (!module) {
      return null;
    }

    return module.reportIncomingCall(options);
  },
  async startCall(options: CallKitCallOptions): Promise<{ callUUID: string } | null> {
    const module = getNativeCallKitModule();
    if (!module) {
      return null;
    }

    return module.startCall(options);
  },
  async updateCall(options: CallKitCallOptions): Promise<void> {
    const module = getNativeCallKitModule();
    if (!module) {
      return;
    }

    await module.updateCall(options);
  },
};
