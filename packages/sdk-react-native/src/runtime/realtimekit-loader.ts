import { ensureIosSimulatorWebRtcSafety, isIosSimulator } from "../utils/ios-simulator";

export const importReactNativeRealtimeKit = async () => {
  if (isIosSimulator()) {
    const webRtcModule = await import("@cloudflare/react-native-webrtc");
    ensureIosSimulatorWebRtcSafety(webRtcModule);
  }

  const module = await import("@cloudflare/realtimekit-react-native");
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
