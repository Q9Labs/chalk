import { useEffect, useState } from "react";
import { observeInputLevel } from "./useInputLevel";

// Near digital zero (-100 dBFS), not a voice activity threshold.
const ZERO_INPUT_RMS = 0.00001;
const SILENCE_MS = 12_000;
const MAX_SAMPLE_GAP_MS = 500;

export function useSilentMicrophone(track: MediaStreamTrack | null) {
  const [notice, setNotice] = useState<{ track: MediaStreamTrack; dismissed: boolean } | null>(null);
  if (notice && notice.track !== track) setNotice(null);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Stop observing microphone input when the active track changes.
  useEffect(() => {
    if (!track) return;
    let lastSample = 0;
    let zeroSince: number | undefined;
    let silent = false;
    return observeInputLevel(track, (rms) => {
      const now = performance.now();
      const zero = rms !== null && rms <= ZERO_INPUT_RMS;
      if (!zero || now - lastSample > MAX_SAMPLE_GAP_MS) {
        zeroSince = undefined;
        if (silent) {
          silent = false;
          setNotice(null);
        }
      }
      lastSample = now;
      if (!zero) return;

      zeroSince ??= now;
      if (!silent && now - zeroSince >= SILENCE_MS) {
        silent = true;
        setNotice({ track, dismissed: false });
      }
    });
  }, [track]);

  return {
    visible: notice !== null && notice.track === track && !notice.dismissed,
    dismiss: () => setNotice((current) => current && { ...current, dismissed: true }),
  };
}
