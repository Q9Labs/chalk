export type HapticPattern = "light" | "medium" | "heavy" | "soft" | "selection" | "success" | "warning" | "error";
export type ChalkHapticInput = HapticPattern;

const vibrationPattern: Record<HapticPattern, number | number[]> = {
  light: 8,
  medium: 16,
  heavy: 28,
  soft: 6,
  selection: 10,
  success: [8, 24, 8],
  warning: [16, 32, 16],
  error: [30, 24, 30],
};

export function useHaptics({ enabled = true }: { enabled?: boolean } = {}) {
  const isSupported = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

  return {
    isSupported,
    trigger: async (pattern: HapticPattern = "selection") => {
      if (!enabled || !isSupported) {
        return;
      }

      navigator.vibrate(vibrationPattern[pattern]);
    },
  };
}
