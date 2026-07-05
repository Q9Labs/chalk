export type HapticPattern = "light" | "medium" | "heavy" | "soft" | "selection" | "success" | "warning" | "error";
export type ChalkHapticInput = HapticPattern;
export function useHaptics(_options: unknown = {}) {
  return { trigger: async (_pattern?: HapticPattern) => {}, isSupported: false };
}
