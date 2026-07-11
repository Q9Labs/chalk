import realtimeKitModule from "@cloudflare/realtimekit-react-native";
import * as reactNativeWebRtc from "@cloudflare/react-native-webrtc";
import { ensureIosSimulatorWebRtcSafety, isIosSimulator } from "../utils/ios-simulator";

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
