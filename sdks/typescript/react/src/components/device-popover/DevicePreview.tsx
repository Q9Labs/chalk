import type { CameraPreview as CameraPreviewHandle } from "@q9labsai/chalk-client";
import { useEffect, useRef, useState } from "react";
import { useInputLevel } from "../../internal/useInputLevel";

export function InputLevel({ track }: { readonly track?: MediaStreamTrack | null }) {
  const level = useInputLevel(track);
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
