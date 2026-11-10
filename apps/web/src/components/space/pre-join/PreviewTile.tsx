import type { PreJoinDevices } from "@q9labsai/chalk-react";
import { cn, getParticipantAvatarGradient, getParticipantInitials, Microphone01Icon, MicrophoneOff01Icon, Video01Icon, VideoOffIcon } from "@q9labsai/chalk-react/utils";
import { useEffect, useRef, type ReactNode } from "react";

/** A glass circle on the preview: the same off style as the call's dock, with an amber badge when the device is missing. */
function PreviewButton({ label, on, missing, disabled, onClick, children }: { readonly label: string; readonly on: boolean; readonly missing: boolean; readonly disabled: boolean; readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled || missing}
      onClick={onClick}
      className={cn("relative grid size-12 place-items-center rounded-full bg-[var(--chalk-popover)] text-[var(--chalk-text)] ring-1 ring-[var(--chalk-line)]", !on && !missing && "text-[var(--chalk-danger-text)]", missing && "text-[var(--chalk-muted-text)]")}
    >
      {children}
      {missing ? (
        <span aria-hidden="true" className="absolute right-0 top-0 grid size-4 place-items-center rounded-full bg-[var(--chalk-warning)] text-(length:--type-micro) font-bold text-[var(--chalk-accent-text)] ring-1 ring-[var(--chalk-line)]">
          !
        </span>
      ) : null}
    </button>
  );
}

/** The visitor's own picture, mirrored like the in-call self view, with the mic and camera buttons on top. */
export function PreviewTile({
  devices,
  displayName,
  locked,
  dimmed,
  onToggle,
  children,
}: {
  readonly devices: PreJoinDevices;
  readonly displayName: string;
  readonly locked: boolean;
  readonly dimmed: boolean;
  readonly onToggle: (device: "microphone" | "camera") => void;
  readonly children?: ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const { cameraTrack } = devices;
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = cameraTrack ? new MediaStream([cameraTrack]) : null;
    return () => {
      element.srcObject = null;
    };
  }, [cameraTrack]);
  const granted = devices.access === "granted";
  const name = displayName.trim() || "You";
  return (
    <div className="relative h-[338px] overflow-hidden rounded-2xl bg-[var(--chalk-tile)] min-[900px]:w-[600px]">
      <video ref={video} autoPlay muted playsInline aria-hidden={!cameraTrack} className={cn("absolute inset-0 size-full object-cover", !cameraTrack && "hidden", dimmed && "opacity-35")} style={{ transform: devices.mirrored ? "scaleX(-1)" : undefined }} />
      {cameraTrack ? null : (
        <span
          aria-hidden="true"
          className={cn("absolute left-1/2 top-1/2 grid size-28 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-(length:--type-title) font-semibold text-[var(--chalk-on-overlay)]", dimmed && "opacity-35")}
          style={{ background: getParticipantAvatarGradient(name) }}
        >
          {getParticipantInitials(name)}
        </span>
      )}
      {granted ? <span className="absolute left-3 top-3 inline-flex h-7 items-center rounded-full bg-[var(--chalk-popover)] px-2.5 text-(length:--type-caption) font-medium text-[var(--chalk-soft-text)]">Only you see this</span> : null}
      <span className="absolute bottom-3 left-3 max-w-[40%] truncate rounded-lg bg-[var(--chalk-popover)] px-2.5 py-1 text-(length:--type-caption) font-medium">{name}</span>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2">
        <PreviewButton label={devices.microphoneOn ? "Turn off microphone" : "Turn on microphone"} on={devices.microphoneOn} missing={devices.microphoneMissing} disabled={locked} onClick={() => onToggle("microphone")}>
          {devices.microphoneOn ? <Microphone01Icon size={20} aria-hidden="true" /> : <MicrophoneOff01Icon size={20} aria-hidden="true" />}
        </PreviewButton>
        <PreviewButton label={devices.cameraOn ? "Turn off camera" : "Turn on camera"} on={devices.cameraOn} missing={devices.cameraMissing} disabled={locked} onClick={() => onToggle("camera")}>
          {devices.cameraOn ? <Video01Icon size={20} aria-hidden="true" /> : <VideoOffIcon size={20} aria-hidden="true" />}
        </PreviewButton>
      </div>
      {children}
    </div>
  );
}
