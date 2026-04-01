import { NativeModules, Platform } from "react-native";

const IOS_SIMULATOR_MEDIA_MESSAGE = "Camera and microphone are unavailable in the iOS Simulator. Join starts with media off.";
const EMPTY_RTP_CAPABILITIES = Object.freeze({
  codecs: [],
  headerExtensions: [],
});

function createEmptyRtpCapabilities() {
  return {
    codecs: [...EMPTY_RTP_CAPABILITIES.codecs],
    headerExtensions: [...EMPTY_RTP_CAPABILITIES.headerExtensions],
  };
}

function patchWebRtcCapabilities(target: any) {
  if (!target || typeof target.getCapabilities !== "function" || target.getCapabilities.__chalkSimulatorPatched === true) {
    return;
  }

  const getCapabilities = (kind?: string) => {
    if (kind !== "audio" && kind !== "video") {
      return createEmptyRtpCapabilities();
    }

    return createEmptyRtpCapabilities();
  };

  Object.defineProperty(getCapabilities, "__chalkSimulatorPatched", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  target.getCapabilities = getCapabilities;
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
  const sender = webRtcModule?.RTCRtpSender ?? scope.RTCRtpSender;
  const receiver = webRtcModule?.RTCRtpReceiver ?? scope.RTCRtpReceiver;

  patchWebRtcCapabilities(sender);
  patchWebRtcCapabilities(receiver);

  if (scope.RTCRtpSender) {
    patchWebRtcCapabilities(scope.RTCRtpSender);
  }

  if (scope.RTCRtpReceiver) {
    patchWebRtcCapabilities(scope.RTCRtpReceiver);
  }
}
