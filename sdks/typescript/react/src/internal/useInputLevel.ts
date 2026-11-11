import { useEffect, useState } from "react";

/** The loudness of a microphone track from 0 to 100, sampled every 100 ms. */
export function useInputLevel(track?: MediaStreamTrack | null): number {
  const [level, setLevel] = useState(0);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Own the microphone meter AudioContext and sampling interval; disconnect, close and clear them on track replacement.
  useEffect(() => {
    if (!track || track.readyState !== "live") {
      setLevel(0);
      return;
    }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      setLevel(Math.min(100, Math.round(rms * 400)));
    }, 100);
    return () => {
      clearInterval(timer);
      source.disconnect();
      void context.close();
    };
  }, [track]);
  return level;
}
