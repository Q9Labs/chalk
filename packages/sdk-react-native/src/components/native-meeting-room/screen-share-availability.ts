export interface NativeScreenShareAvailability {
  enabled: boolean;
  reason: string | null;
  detail: string | null;
}

export function resolveNativeScreenShareAvailability({ featureEnabled }: { featureEnabled: boolean }): NativeScreenShareAvailability {
  if (!featureEnabled) {
    return {
      enabled: false,
      reason: "feature-disabled",
      detail: "features.screenShare=false in meeting room props",
    };
  }

  return {
    enabled: true,
    reason: null,
    detail: null,
  };
}
