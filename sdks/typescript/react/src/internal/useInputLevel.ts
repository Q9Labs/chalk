import { useEffect, useState } from "react";

const SAMPLE_MS = 100;

/** A sample is null when the browser isn't providing live, readable input. */
export function observeInputLevel(track: MediaStreamTrack, sample: (rms: number | null) => void): (() => void) | undefined {
  if (track.readyState !== "live") return;
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const audio = context;
    const resume = () => {
      if (audio.state === "suspended") void audio.resume().catch(() => undefined);
    };
    // A preview can mount before the browser allows Web Audio to start.
    document.addEventListener("pointerdown", resume);
    document.addEventListener("keydown", resume);
    const timer = window.setInterval(() => {
      if (audio.state !== "running" || !track.enabled || track.muted || track.readyState !== "live") {
        sample(null);
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      const energy = samples.reduce((sum, value) => sum + value * value, 0);
      sample(Math.sqrt(energy / samples.length));
    }, SAMPLE_MS);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("pointerdown", resume);
      document.removeEventListener("keydown", resume);
      source.disconnect();
      void audio.close().catch(() => undefined);
    };
  } catch {
    // No analyser is not evidence of a silent microphone.
    void context?.close().catch(() => undefined);
  }
}

/** The loudness of a microphone track from 0 to 100, sampled every 100 ms. */
export function useInputLevel(track?: MediaStreamTrack | null): number {
  const [level, setLevel] = useState(0);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Own the microphone meter AudioContext and sampling interval; disconnect, close and clear them on track replacement.
  useEffect(() => {
    setLevel(0);
    if (track) return observeInputLevel(track, (rms) => setLevel(Math.min(100, Math.round((rms ?? 0) * 400))));
  }, [track]);
  return level;
}
