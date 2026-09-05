export interface NativeScreenShareAvailability {
  enabled: boolean;
  reason: string | null;
  detail: string | null;
}

export function resolveNativeScreenShareAvailability({ featureEnabled, platform, simulator, captureAvailable }: { featureEnabled: boolean; platform: string; simulator: boolean; captureAvailable: boolean }): NativeScreenShareAvailability {
  if (!featureEnabled) {
    return {
      enabled: false,
      reason: "feature-disabled",
      detail: "features.screenShare=false in SpaceView props",
    };
  }

  if (simulator) return { enabled: false, reason: "simulator", detail: "Screen sharing requires a physical device." };
  if ((platform !== "ios" && platform !== "android") || !captureAvailable) return { enabled: false, reason: "runtime-unsupported", detail: "Screen sharing is unavailable in this app runtime. Use a supported native build or share from the web app." };

  return {
    enabled: true,
    reason: null,
    detail: null,
  };
}
