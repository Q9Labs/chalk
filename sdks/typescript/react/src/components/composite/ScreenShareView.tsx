import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMedia, useParticipants, useSelf } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { StageIcon } from "../stage/StageIcon";
import { toVideoParticipants } from "../../selectors/space-selectors";
import { ChalkButton, ChalkMenu, ChalkMenuItem } from "../chalk-ui";
import { SignalBars } from "../participant-tile/ParticipantTile";
import { TileShell } from "../participant-tile/TileShell";
import { useVideoTrack } from "../participant-tile/useVideoTrack";

export type ScreenShareState = "live" | "connecting" | "paused" | "low-quality";
export interface ScreenShareViewProps {
  readonly className?: string;
}
export interface ScreenSharePresentationProps extends ScreenShareViewProps {
  readonly sharedByName: string;
  readonly media: React.ReactNode;
  readonly mediaVisible: boolean;
  readonly state?: ScreenShareState;
  readonly isLocal?: boolean;
  readonly hasAudio?: boolean;
  readonly capture?: ScreenShareCapture;
  readonly primary?: boolean;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
  readonly style?: React.CSSProperties;
  readonly onClick?: () => void;
  readonly onDoubleClick?: () => void;
  readonly onStopSharing?: () => Promise<void>;
  readonly onChangeShare?: (options: ScreenShareOptions) => Promise<void>;
  readonly switcher?: React.ReactNode;
}
export interface ScreenShareViewSurfaceProps extends Omit<ScreenSharePresentationProps, "media" | "mediaVisible"> {
  readonly screenShareTrack: MediaStreamTrack;
}

/** Stable media layer: connecting/paused chrome never removes the video or its last decoded frame. */
export function ScreenSharePresentation({ sharedByName, media, mediaVisible, state, isLocal = false, hasAudio = false, capture, primary = true, pinned, hidden, style, onClick, onDoubleClick, onStopSharing, onChangeShare, switcher, className }: ScreenSharePresentationProps): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [fill, setFill] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [poppedOut, setPoppedOut] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = state ?? (mediaVisible ? "live" : "connecting");
  const name = isLocal ? "Your screen" : `${sharedByName}'s screen`;
  const source = capture?.surface === "monitor" ? "your screen" : capture?.surface === "browser" ? "a tab" : "a window";
  const run = async (command: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await command();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The share could not be changed.");
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    const video = root.current?.querySelector("video");
    if (!video) return;
    const entered = () => setPoppedOut(true);
    const left = () => setPoppedOut(false);
    video.addEventListener("enterpictureinpicture", entered);
    video.addEventListener("leavepictureinpicture", left);
    return () => {
      video.removeEventListener("enterpictureinpicture", entered);
      video.removeEventListener("leavepictureinpicture", left);
    };
  }, [media]);
  const fullscreen = () =>
    run(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.current?.closest<HTMLElement>('[data-part="stage-tile"]')?.requestFullscreen();
    });
  const popout = () =>
    run(async () => {
      const video = root.current?.querySelector("video");
      if (!video || !document.pictureInPictureEnabled) throw new Error("Picture-in-picture is not available in this browser.");
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    });
  return (
    <TileShell
      label={`Screen share tile for ${sharedByName}`}
      accentColor="var(--chalk-focus)"
      pinned={pinned}
      onClick={primary ? undefined : onClick}
      onDoubleClick={onDoubleClick}
      hidden={hidden}
      style={style}
      className={cn("h-full w-full", className)}
      chip={
        <>
          <StageIcon name="share" size={14} className="shrink-0" />
          <span dir="auto" className="min-w-0 truncate [unicode-bidi:plaintext]">
            {name}
          </span>
          {hasAudio ? <StageIcon name="volume" size={14} aria-label="With share audio" className="shrink-0" /> : null}
        </>
      }
    >
      <div
        ref={root}
        className="absolute inset-0 bg-[var(--chalk-tile)]"
        onPointerUp={(event) => {
          if (primary && event.pointerType !== "mouse" && !(event.target instanceof Element && event.target.closest("button"))) setControlsOpen((open) => !open);
        }}
      >
        <div data-part="share-media" className={cn("absolute inset-0 overflow-hidden motion-safe:transition-opacity motion-safe:duration-300 motion-safe:ease-[ease-out]", poppedOut ? "opacity-0" : status === "paused" ? "opacity-35" : "opacity-100")}>
          <div
            className={cn("h-full w-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-[ease-out] [&>*]:h-full [&>*]:w-full", status === "low-quality" && "blur-[2.5px]", fill ? "[&>*]:object-cover" : "[&>*]:object-contain")}
            style={{ transform: zoom ? "scale(2)" : undefined }}
          >
            {media}
          </div>
        </div>
        {poppedOut ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-4 text-center text-[var(--chalk-muted-text)]">
            <StageIcon name="pip" size={32} />
            <p className="font-medium text-[var(--chalk-text)]">{name} is in a picture-in-picture window</p>
            <ChalkButton className="!h-8 !px-3" onClick={() => void popout()}>
              Bring it back
            </ChalkButton>
          </div>
        ) : null}
        {status === "connecting" ? (
          <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--chalk-tile)] text-[var(--chalk-muted-text)]">
            <span className="h-[18px] w-[18px] rounded-[50%] border-2 border-[var(--chalk-line-strong)] border-t-[var(--chalk-text)] motion-safe:animate-spin motion-safe:[animation-duration:.9s] motion-reduce:border-t-[var(--chalk-muted-text)]" />
            <p className="font-medium text-[var(--chalk-text)]">Connecting to {sharedByName}’s screen…</p>
          </div>
        ) : null}
        {status === "paused" ? (
          <div role="status" className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-white">
            <span className="grid h-12 w-12 place-items-center rounded-[50%] bg-[rgba(12,14,18,.82)]">
              <StageIcon name="pause" size={24} />
            </span>
            <p className="rounded-[8px] bg-[rgba(12,14,18,.82)] px-3 py-1.5 font-semibold">{sharedByName} paused sharing</p>
          </div>
        ) : null}
        {status === "low-quality" ? (
          <div role="status" data-part="share-low-quality" className="absolute top-2 left-2 z-30 flex h-7 items-center gap-2 rounded-[6px] bg-[rgba(12,14,18,.82)] px-2.5 text-[12px] font-medium text-white">
            <SignalBars />
            <span>{sharedByName}’s connection is slow</span>
          </div>
        ) : null}
        {primary ? switcher : null}
        {isLocal && primary ? (
          <div data-part="share-local-overlay" role="group" aria-label="Your share" className="absolute top-2.5 right-2.5 left-2.5 z-30 flex items-center gap-2 rounded-[12px] bg-[rgba(12,14,18,.86)] p-2 pl-3.5 text-white max-[640px]:flex-wrap">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <b className="truncate font-semibold">You’re sharing {source}</b>
              {capture?.surface === "monitor" || capture?.surface === "browser" ? <span className="text-[12px] text-[#c9cbd1]">Seeing a mirror effect? That’s normal when you share {capture.surface === "browser" ? "this tab" : "your whole screen"}.</span> : null}
            </div>
            {onChangeShare ? (
              <ChalkMenu
                trigger={
                  <ChalkButton disabled={pending} className="!h-8 !bg-white/[.14] !px-3 !text-white hover:!bg-white/[.22]">
                    Change
                  </ChalkButton>
                }
              >
                {(
                  [
                    { surface: "monitor", label: "Entire screen" },
                    { surface: "window", label: "Window" },
                    { surface: "browser", label: "Browser tab" },
                  ] as const
                ).map((option) => (
                  <ChalkMenuItem key={option.surface} onClick={() => void run(() => onChangeShare({ surface: option.surface, audio: option.surface === "browser" }))}>
                    {option.label}
                  </ChalkMenuItem>
                ))}
              </ChalkMenu>
            ) : null}
            {onStopSharing ? (
              <ChalkButton disabled={pending} tone="danger" className="!h-8 !bg-[var(--chalk-danger)] !px-3 !text-white hover:!bg-[var(--chalk-danger-hover)]" onClick={() => void run(onStopSharing)}>
                Stop sharing
              </ChalkButton>
            ) : null}
          </div>
        ) : null}
        {primary && !isLocal && status !== "connecting" ? (
          <div role="toolbar" aria-label="Share controls" className={cn("absolute right-2 bottom-2 z-30 flex gap-1.5 opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 focus-within:opacity-100", controlsOpen && "opacity-100")}>
            <ShareControl label={fill ? "Fit the whole screen" : "Fill the tile"} pressed={fill} onClick={() => setFill(!fill)}>
              <StageIcon name={fill ? "fit" : "fill"} size={16} />
            </ShareControl>
            <ShareControl label={zoom ? "Zoom out" : "Zoom in"} pressed={zoom} onClick={() => setZoom(!zoom)}>
              <StageIcon name={zoom ? "zoom-out" : "zoom-in"} size={16} />
            </ShareControl>
            <ShareControl label="Pop out" onClick={() => void popout()}>
              <StageIcon name="pip" size={16} />
            </ShareControl>
            <ShareControl label="Full screen" onClick={() => void fullscreen()}>
              <StageIcon name="maximize" size={16} />
            </ShareControl>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="absolute right-2 bottom-12 left-2 z-40 rounded-md bg-[rgba(12,14,18,.86)] p-2 text-sm text-white">
            {error}
          </p>
        ) : null}
      </div>
    </TileShell>
  );
}
function ShareControl({ label, pressed, onClick, children }: { readonly label: string; readonly pressed?: boolean; readonly onClick: () => void; readonly children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="relative grid h-8 w-8 place-items-center rounded-[50%] bg-[rgba(12,14,18,.75)] text-white outline-none hover:bg-[rgba(40,42,48,.95)] aria-pressed:bg-white aria-pressed:text-[#0b0c0e] motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-[ease-out] active:scale-[.92] focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-1.5"
    >
      {children}
    </button>
  );
}
export function ScreenShareViewSurface({ screenShareTrack, ...props }: ScreenShareViewSurfaceProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const status = useVideoTrack(videoRef, screenShareTrack, !props.hidden);
  return <ScreenSharePresentation {...props} state={props.state ?? (status === "muted" ? "paused" : undefined)} media={<video ref={videoRef} autoPlay playsInline muted />} mediaVisible={status === "playing" || status === "muted"} />;
}
export function ScreenShareView(props: ScreenShareViewProps): React.JSX.Element {
  const self = useSelf();
  const participantsSlice = useParticipants();
  const media = useMedia();
  const localId = self.participantId ?? "local";
  const participants = useMemo(() => toVideoParticipants(participantsSlice.roster, media.remote, localId, self.displayName ?? "You", media.local), [localId, media.local, media.remote, participantsSlice.roster, self.displayName]);
  const active = participants.find((participant) => participant.isScreenSharing && participant.screenShareTrack);
  if (!active?.screenShareTrack)
    return (
      <div className="grid h-full place-items-center text-sm text-[var(--chalk-muted-text)]" role="status">
        No active screen share
      </div>
    );
  return <ScreenShareViewSurface {...props} screenShareTrack={active.screenShareTrack} sharedByName={active.displayName} hasAudio={participantsSlice.roster.find((person) => person.participantId === active.id)?.media.screenShareHasAudio} />;
}
