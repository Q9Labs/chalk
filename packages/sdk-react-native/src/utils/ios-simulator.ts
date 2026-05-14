import { NativeModules, Platform } from "react-native";

const IOS_SIMULATOR_MEDIA_MESSAGE = "Camera and microphone are unavailable in the iOS Simulator. Join starts with media off.";
const EMPTY_RTP_CAPABILITIES = Object.freeze({
  codecs: [],
  headerExtensions: [],
});

const CHALK_SIMULATOR_PATCHED = "__chalkSimulatorPatched";

function createEmptyRtpCapabilities() {
  return {
    codecs: [...EMPTY_RTP_CAPABILITIES.codecs],
    headerExtensions: [...EMPTY_RTP_CAPABILITIES.headerExtensions],
  };
}

function markPatched(target: object, key: string) {
  Object.defineProperty(target, key, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function patchWebRtcCapabilities(target: any) {
  if (!target || typeof target.getCapabilities !== "function" || target.getCapabilities[CHALK_SIMULATOR_PATCHED] === true) {
    return;
  }

  const getCapabilities = (kind?: string) => {
    if (kind !== "audio" && kind !== "video") {
      return createEmptyRtpCapabilities();
    }

    return createEmptyRtpCapabilities();
  };

  markPatched(getCapabilities, CHALK_SIMULATOR_PATCHED);

  target.getCapabilities = getCapabilities;
}

function patchNativeWebRtcCapabilities(nativeModule: Record<string, unknown> | undefined) {
  if (!nativeModule) {
    return;
  }

  const capabilityMethods = ["receiverGetCapabilities", "senderGetCapabilities"] as const;

  capabilityMethods.forEach((methodName) => {
    const originalMethod = nativeModule[methodName];

    if (typeof originalMethod !== "function" || (originalMethod as ((...args: Array<unknown>) => unknown) & { [CHALK_SIMULATOR_PATCHED]?: boolean })[CHALK_SIMULATOR_PATCHED] === true) {
      return;
    }

    const safeMethod = () => createEmptyRtpCapabilities();
    markPatched(safeMethod, CHALK_SIMULATOR_PATCHED);
    nativeModule[methodName] = safeMethod;
  });
}

function patchMediaDeviceEnumeration(mediaDevices: Record<string, unknown> | undefined) {
  if (!mediaDevices) {
    return;
  }

  const enumerateDevices = mediaDevices.enumerateDevices;

  if (typeof enumerateDevices !== "function" || (enumerateDevices as ((...args: Array<unknown>) => unknown) & { [CHALK_SIMULATOR_PATCHED]?: boolean })[CHALK_SIMULATOR_PATCHED] === true) {
    return;
  }

  const safeEnumerateDevices = async () => [];
  markPatched(safeEnumerateDevices, CHALK_SIMULATOR_PATCHED);
  mediaDevices.enumerateDevices = safeEnumerateDevices;
}

export function isIosSimulator(): boolean {
  if (Platform.OS !== "ios") {
    return false;
  }

  const runtimeInfo = NativeModules.ChalkRuntimeInfo as { isSimulator?: boolean } | undefined;
  return runtimeInfo?.isSimulator === true;
}

export function getIosSimulatorVideoMessage(): string {
  return IOS_SIMULATOR_MEDIA_MESSAGE;
}

export function getIosSimulatorMediaMessage(): string {
  return IOS_SIMULATOR_MEDIA_MESSAGE;
}

export function ensureIosSimulatorWebRtcSafety(webRtcModule?: any): void {
  if (!isIosSimulator()) {
    return;
  }

  const scope = globalThis as any;
  const nativeWebRtcModule = NativeModules.WebRTCModule as Record<string, unknown> | undefined;
  const patchedMediaDevices = webRtcModule?.mediaDevices ?? scope.mediaDevices ?? scope.navigator?.mediaDevices;
  const sender = webRtcModule?.RTCRtpSender ?? scope.RTCRtpSender;
  const receiver = webRtcModule?.RTCRtpReceiver ?? scope.RTCRtpReceiver;

  patchNativeWebRtcCapabilities(nativeWebRtcModule);
  patchMediaDeviceEnumeration(patchedMediaDevices);
  patchWebRtcCapabilities(sender);
  patchWebRtcCapabilities(receiver);

  if (scope.RTCRtpSender) {
    patchWebRtcCapabilities(scope.RTCRtpSender);
  }

  if (scope.RTCRtpReceiver) {
    patchWebRtcCapabilities(scope.RTCRtpReceiver);
  }

  if (scope.navigator?.mediaDevices) {
    patchMediaDeviceEnumeration(scope.navigator.mediaDevices);
  }
}
