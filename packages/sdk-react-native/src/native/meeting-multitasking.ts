import { NativeModules, Platform } from "react-native";

interface NativeMeetingMultitaskingConfig {
  roomName: string;
  participantName: string;
  streamURL: string | null;
  muted: boolean;
  cameraOff: boolean;
}

interface NativeMeetingMultitaskingModule {
  isPictureInPictureSupported: () => Promise<boolean>;
  isPictureInPictureActive: () => Promise<boolean>;
  setPictureInPictureEnabled: (enabled: boolean) => Promise<void>;
  updatePictureInPictureConfig: (config: NativeMeetingMultitaskingConfig) => Promise<void>;
  startPictureInPicture: () => Promise<void>;
  stopPictureInPicture: () => Promise<void>;
  startBackgroundMode: (config: NativeMeetingMultitaskingConfig) => Promise<void>;
  stopBackgroundMode: () => Promise<void>;
}

const noopModule: NativeMeetingMultitaskingModule = {
  isPictureInPictureSupported: async () => false,
  isPictureInPictureActive: async () => false,
  setPictureInPictureEnabled: async () => {},
  updatePictureInPictureConfig: async () => {},
  startPictureInPicture: async () => {},
  stopPictureInPicture: async () => {},
  startBackgroundMode: async () => {},
  stopBackgroundMode: async () => {},
};

function resolveNativeMeetingMultitaskingModule(): NativeMeetingMultitaskingModule {
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return noopModule;
  }

  const module = NativeModules.ChalkMeetingMultitasking as Partial<NativeMeetingMultitaskingModule> | undefined;
  if (!module) {
    return noopModule;
  }

  return {
    isPictureInPictureSupported: module.isPictureInPictureSupported ?? noopModule.isPictureInPictureSupported,
    isPictureInPictureActive: module.isPictureInPictureActive ?? noopModule.isPictureInPictureActive,
    setPictureInPictureEnabled: module.setPictureInPictureEnabled ?? noopModule.setPictureInPictureEnabled,
    updatePictureInPictureConfig: module.updatePictureInPictureConfig ?? noopModule.updatePictureInPictureConfig,
    startPictureInPicture: module.startPictureInPicture ?? noopModule.startPictureInPicture,
    stopPictureInPicture: module.stopPictureInPicture ?? noopModule.stopPictureInPicture,
    startBackgroundMode: module.startBackgroundMode ?? noopModule.startBackgroundMode,
    stopBackgroundMode: module.stopBackgroundMode ?? noopModule.stopBackgroundMode,
  };
}

export const meetingMultitasking = resolveNativeMeetingMultitaskingModule();
export type { NativeMeetingMultitaskingConfig };
