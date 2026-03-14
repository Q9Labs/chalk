import { useCallback } from "react";
import { defaultPatterns, type HapticInput, type TriggerOptions } from "web-haptics";
import { useWebHaptics } from "web-haptics/react";

import { usePrefersReducedMotion } from "../useMediaQuery";

export type ChalkHapticInput = HapticInput;
export type ChalkHapticPreset = keyof typeof defaultPatterns;
export type ChalkHapticTriggerOptions = TriggerOptions;

export interface UseHapticsOptions {
  enabled?: boolean;
  respectReducedMotion?: boolean;
}

export interface UseHapticsReturn {
  trigger: (input?: ChalkHapticInput, options?: ChalkHapticTriggerOptions) => Promise<void>;
  cancel: () => void;
  isSupported: boolean;
  isEnabled: boolean;
  presetNames: readonly ChalkHapticPreset[];
}

const PRESET_NAMES = Object.freeze(Object.keys(defaultPatterns)) as readonly ChalkHapticPreset[];

export function useHaptics({ enabled = true, respectReducedMotion = true }: UseHapticsOptions = {}): UseHapticsReturn {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { trigger: rawTrigger, cancel: rawCancel, isSupported } = useWebHaptics();
  const hasNativeVibration = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
  const supportsHaptics = isSupported || hasNativeVibration;

  const isEnabled = enabled && (!respectReducedMotion || !prefersReducedMotion) && supportsHaptics;

  const trigger = useCallback<UseHapticsReturn["trigger"]>(
    (input = "selection", options) => {
      if (!isEnabled) {
        return Promise.resolve();
      }

      if (!isSupported && hasNativeVibration) {
        navigator.vibrate(8);
        return Promise.resolve();
      }

      return rawTrigger(input, options) ?? Promise.resolve();
    },
    [hasNativeVibration, isEnabled, isSupported, rawTrigger],
  );

  const cancel = useCallback(() => {
    if (!isEnabled) {
      return;
    }

    rawCancel?.();
  }, [isEnabled, rawCancel]);

  return {
    trigger,
    cancel,
    isSupported,
    isEnabled,
    presetNames: PRESET_NAMES,
  };
}
