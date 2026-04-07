import { ensureIosSimulatorWebRtcSafety, isIosSimulator } from "../utils/ios-simulator";

export const importReactNativeRealtimeKit = async () => {
  if (isIosSimulator()) {
    const webRtcModule = require("@cloudflare/react-native-webrtc") as typeof import("@cloudflare/react-native-webrtc");
    ensureIosSimulatorWebRtcSafety(webRtcModule);
  }

  const module = require("@cloudflare/realtimekit-react-native") as typeof import("@cloudflare/realtimekit-react-native");
  const realtimeKit = module.default as any;

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
