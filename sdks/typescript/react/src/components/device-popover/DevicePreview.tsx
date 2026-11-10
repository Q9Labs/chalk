import type { CameraPreview as CameraPreviewHandle } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState } from "react";

export function InputLevel({ track }: { readonly track?: MediaStreamTrack | null }) {
  const [level, setLevel] = useState(0);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Own the microphone meter AudioContext and sampling interval; disconnect, close and clear them on track replacement.
  useEffect(() => {
    if (!track || track.readyState !== "live") return;
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
  return (
    <span className="chalk-shell-level" role="meter" aria-label="Input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
      <i style={{ transform: `scaleX(${level / 100})` }} />
    </span>
  );
}

export function CameraPreview({
  track,
  mirrored,
  open,
  selectedDeviceId,
  captureCameraPreview,
  onDeviceId,
}: {
  readonly onDeviceId: (deviceId: string | null) => void;
  readonly track?: MediaStreamTrack | null;
  readonly mirrored: boolean;
  readonly open: boolean;
  readonly selectedDeviceId?: string;
  readonly captureCameraPreview?: () => Promise<CameraPreviewHandle>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  const trackEnabled = track?.enabled;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Acquire a camera preview for the mounted open popover; release late captures and the owned preview on cleanup.
  useEffect(() => {
    const element = video.current;
    if (!element || !open) return;
    let cancelled = false;
    let preview: CameraPreviewHandle | undefined;
    setUnavailable(false);
    onDeviceId(null);
    if (captureCameraPreview) {
      void captureCameraPreview().then(
        (captured) => {
          if (cancelled) {
            captured.release();
            return;
          }
          preview = captured;
          onDeviceId(captured.track.getSettings().deviceId ?? selectedDeviceId ?? "default");
          element.srcObject = new MediaStream([captured.track]);
        },
        () => {
          if (!cancelled) setUnavailable(true);
        },
      );
    } else if (track?.enabled && track.readyState === "live") {
      onDeviceId(track.getSettings().deviceId ?? selectedDeviceId ?? "default");
      element.srcObject = new MediaStream([track]);
    } else {
      setUnavailable(true);
    }
    return () => {
      cancelled = true;
      element.srcObject = null;
      preview?.release();
    };
  }, [track, trackEnabled, open, selectedDeviceId, captureCameraPreview, onDeviceId]);
  return (
    <>
      <div className="chalk-shell-preview">
        <video ref={video} autoPlay muted playsInline style={{ transform: mirrored ? "scaleX(-1)" : undefined }} />
        <small>{unavailable ? "Camera preview unavailable. Check camera access." : "Only you see this preview"}</small>
      </div>
    </>
  );
}
