import { LocalShareControls } from "./LocalShareControls";
import { ShareViewerHeader } from "./ShareViewerHeader";
import { ShareControl } from "./ShareControl";
import { commandFailure, commandFailureMessage, type MediaCommandSource, type MediaCommandAction } from "../control-bar/command-failure";
import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useMedia, useParticipants, useSelf, useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { AIBadge } from "../atomic/AIBadge";
import { ChalkButton } from "../chalk-ui";
import { StageIcon } from "../stage/StageIcon";
import { toVideoParticipants } from "../../selectors/space-selectors";
import { SignalBars } from "../participant-tile/ParticipantTile";
import { TileShell } from "../participant-tile/TileShell";
import { useVideoTrack } from "../participant-tile/useVideoTrack";
import type { AnnotationPresentationContext } from "../screen-annotation/AnnotationSurface";
import type { ScreenAnnotationOptions } from "../screen-annotation/model";

const AnnotationSurface = lazy(() => import("../screen-annotation/AnnotationSurface"));

export type ScreenShareState = "live" | "connecting" | "paused" | "low-quality";
export interface ScreenShareViewProps {
  readonly className?: string;
  readonly annotation?: ScreenAnnotationOptions;
}
export interface ScreenSharePresentationProps extends ScreenShareViewProps {
  readonly sharedByName: string;
  readonly sharedByAgent?: boolean;
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
  /** Present only for a live track-backed surface, never recording playback. */
  readonly annotationMedia?: AnnotationPresentationContext & {
    readonly track: MediaStreamTrack;
    readonly videoRef: React.RefObject<HTMLVideoElement | null>;
  };
}
export interface ScreenShareViewSurfaceProps extends Omit<ScreenSharePresentationProps, "media" | "mediaVisible" | "annotationMedia"> {
  readonly screenShareTrack: MediaStreamTrack;
  readonly annotationContext?: AnnotationPresentationContext;
}

/** Stable media layer: connecting/paused chrome never removes the video or its last decoded frame. */
export function ScreenSharePresentation({
  sharedByName,
  sharedByAgent = false,
  media,
  mediaVisible,
  state,
  isLocal = false,
  hasAudio = false,
  capture,
  primary = true,
  pinned,
  hidden,
  style,
  onClick,
  onDoubleClick,
  onStopSharing,
  onChangeShare,
  switcher,
  className,
  annotation,
  annotationMedia,
}: ScreenSharePresentationProps): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [canvasHost, setCanvasHost] = useState<HTMLDivElement | null>(null);
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null);
  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);
  const [policyHost, setPolicyHost] = useState<HTMLElement | null>(null);
  const [fill, setFill] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [poppedOut, setPoppedOut] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = state ?? (mediaVisible ? "live" : "connecting");
  const name = isLocal ? "Your screen" : `${sharedByName}'s screen`;
  const run = async (command: () => Promise<unknown>, source?: MediaCommandSource, action?: MediaCommandAction) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await command();
    } catch (cause) {
      setError(source ? commandFailureMessage(commandFailure(cause), source, action) : cause instanceof Error ? cause.message : "The share could not be changed.");
    } finally {
      setPending(false);
    }
  };
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Mirror picture-in-picture events from the mounted video; remove both listeners when media changes.
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
  const ownBigShare = isLocal && primary;
  const viewerHeader = !isLocal && primary && !hidden && Boolean(annotation && annotationMedia);
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
      // The share header already names a big share, so its tag would only repeat it.
      chip={ownBigShare || viewerHeader ? null : <ShareChip agent={sharedByAgent} name={name} withAudio={!isLocal && hasAudio} />}
    >
      <div
        ref={root}
        className="absolute inset-0 flex flex-col bg-[var(--chalk-tile)]"
        onPointerUp={(event) => {
          if (primary && event.pointerType !== "mouse" && !(event.target instanceof Element && event.target.closest("button"))) setControlsOpen((open) => !open);
        }}
      >
        {ownBigShare ? (
          <LocalShareControls
            pending={pending}
            titleHost={setTitleHost}
            policyHost={setPolicyHost}
            onChangeShare={onChangeShare ? (options) => void run(() => onChangeShare(options), "screen", "start") : undefined}
            onStopSharing={onStopSharing ? () => void run(onStopSharing, "screen", "stop") : undefined}
          />
        ) : null}
        {viewerHeader ? <ShareViewerHeader name={name} withAudio={hasAudio} host={setHeaderHost} /> : null}
        <div className="relative min-h-0 flex-1">
          <div data-part="share-media" className={cn("absolute inset-0 overflow-hidden motion-safe:transition-opacity motion-safe:duration-300 motion-safe:ease-[ease-out]", poppedOut ? "opacity-0" : status === "paused" ? "opacity-35" : "opacity-100")}>
            <div
              className={cn("relative h-full w-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-[ease-out] [&>*]:h-full [&>*]:w-full", status === "low-quality" && "blur-[2.5px]", fill ? "[&>*]:object-cover" : "[&>*]:object-contain")}
              style={{ transform: zoom ? "scale(2)" : undefined }}
            >
              {media}
              {annotation && annotationMedia ? <div ref={setCanvasHost} className="pointer-events-none absolute inset-0" /> : null}
            </div>
          </div>
          {annotation && annotationMedia && !hidden ? (
            <Suspense fallback={null}>
              <AnnotationSurface
                {...annotationMedia}
                annotation={annotation}
                canvasHost={canvasHost}
                fit={fill ? "fill" : "fit"}
                primary={primary}
                live={status === "live" && mediaVisible && !poppedOut}
                isLocal={isLocal}
                capture={capture}
                sharerName={sharedByName}
                headerHost={headerHost}
                titleHost={titleHost}
                policyHost={policyHost}
              />
            </Suspense>
          ) : null}
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
            <div role="status" className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-[var(--chalk-on-overlay)]">
              <span className="grid h-12 w-12 place-items-center rounded-[50%] bg-[var(--chalk-overlay-strong)]">
                <StageIcon name="pause" size={24} />
              </span>
              <p className="rounded-(--corner-lg) bg-[var(--chalk-overlay-strong)] px-3 py-1.5 font-semibold">{sharedByName} paused sharing</p>
            </div>
          ) : null}
          {status === "low-quality" ? (
            <div role="status" data-part="share-low-quality" className="absolute top-2 left-2 z-30 flex h-7 items-center gap-2 rounded-(--corner-md) bg-[var(--chalk-overlay-strong)] px-2.5 text-(length:--type-caption) font-medium text-[var(--chalk-on-overlay)]">
              <SignalBars />
              <span>{sharedByName}’s connection is slow</span>
            </div>
          ) : null}
          {primary ? switcher : null}
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
            <p role="alert" className="absolute right-2 bottom-12 left-2 z-40 rounded-md bg-[var(--chalk-overlay-strong)] p-2 text-sm text-[var(--chalk-on-overlay)]">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </TileShell>
  );
}
export function ScreenShareViewSurface({ screenShareTrack, annotationContext, ...props }: ScreenShareViewSurfaceProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const status = useVideoTrack(videoRef, screenShareTrack, !props.hidden);
  const annotationMedia = props.annotation && annotationContext ? { ...annotationContext, track: screenShareTrack, videoRef } : undefined;
  return <ScreenSharePresentation {...props} annotationMedia={annotationMedia} state={props.state ?? (status === "muted" ? "paused" : undefined)} media={<video ref={videoRef} autoPlay playsInline muted />} mediaVisible={status === "playing" || status === "muted"} />;
}
export function ScreenShareView(props: ScreenShareViewProps): React.JSX.Element {
  const client = useSpaceClient();
  const connection = useConnection();
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
  return (
    <ScreenShareViewSurface
      {...props}
      annotation={props.annotation && (active.isLocal || props.annotation.publicationId === active.screenSharePublicationId) ? props.annotation : undefined}
      annotationContext={self.participantId ? { actorId: self.participantId, actorName: self.displayName ?? "You" } : undefined}
      screenShareTrack={active.screenShareTrack}
      sharedByName={active.displayName}
      sharedByAgent={active.identityKind === "agent"}
      isLocal={active.isLocal}
      hasAudio={active.isLocal ? media.screenShare.hasAudio : participantsSlice.roster.find((person) => person.participantId === active.id)?.media.screenShareHasAudio}
      capture={active.isLocal ? media.screenShare.capture : undefined}
      onStopSharing={
        active.isLocal
          ? async () => {
              await client.media.setScreenShareEnabled(false);
            }
          : undefined
      }
      onChangeShare={
        active.isLocal && connection.status === "live"
          ? async (options) => {
              await client.media.setScreenShareEnabled(true, options);
            }
          : undefined
      }
    />
  );
}

function ShareChip({ name, agent, withAudio }: { readonly name: string; readonly agent: boolean; readonly withAudio: boolean }) {
  return (
    <>
      <StageIcon name="share" size={14} className="shrink-0" />
      <span dir="auto" className="min-w-0 truncate [unicode-bidi:plaintext]">
        {name}
      </span>
      {agent ? <AIBadge /> : null}
      {withAudio ? <StageIcon name="volume" size={14} aria-label="With share audio" className="shrink-0" /> : null}
    </>
  );
}
