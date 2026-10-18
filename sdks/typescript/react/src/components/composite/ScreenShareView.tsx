import React, { useEffect, useMemo, useRef } from "react";
import { useMedia, useParticipants, useSelf } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { Monitor01Icon } from "../../utils/icons";
import { toVideoParticipants } from "../../selectors/space-selectors";
import { ChalkEmptyState } from "../chalk-ui";

export interface ScreenShareViewProps {
  readonly className?: string;
}
export interface ScreenShareViewSurfaceProps extends ScreenShareViewProps {
  readonly screenShareTrack: MediaStreamTrack;
  readonly sharedByName: string;
}
export interface ScreenSharePresentationProps {
  readonly sharedByName: string;
  readonly media: React.ReactNode;
  readonly mediaVisible: boolean;
  readonly className?: string;
}

export function ScreenSharePresentation({ sharedByName, media, mediaVisible, className }: ScreenSharePresentationProps): React.JSX.Element {
  const viewport = (
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden bg-[var(--chalk-text)]">
      {mediaVisible ? <div className="absolute inset-0 [&>*]:h-full [&>*]:w-full [&>*]:object-contain">{media}</div> : null}
      {!mediaVisible ? (
        <ChalkEmptyState className="grid h-full place-items-center text-sm text-[var(--chalk-app-text-muted)]" title="Screen share unavailable" description={`${sharedByName}’s screen isn’t available at this moment.`}>
          <Monitor01Icon size={32} aria-hidden="true" />
        </ChalkEmptyState>
      ) : null}
      <SharedByTag name={sharedByName} />
    </div>
  );
  return <div className={cn("h-full w-full overflow-hidden rounded-2xl bg-[var(--chalk-text)]", className)}>{viewport}</div>;
}

function SharedByTag({ name, className }: { readonly name: string; readonly className?: string }): React.JSX.Element {
  return <span className={cn("absolute top-3 left-3 rounded-md bg-[rgba(12,14,18,0.62)] px-2 py-1 text-xs font-medium text-white ring-1 ring-white/10 backdrop-blur-md", className)}>Shared by {name}</span>;
}

export function ScreenShareViewSurface({ screenShareTrack, sharedByName, className }: ScreenShareViewSurfaceProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = new MediaStream([screenShareTrack]);
    return () => {
      video.srcObject = null;
    };
  }, [screenShareTrack]);
  return <ScreenSharePresentation sharedByName={sharedByName} media={<video ref={videoRef} autoPlay playsInline muted />} mediaVisible className={className} />;
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
      <div className="grid h-full place-items-center text-sm text-[var(--chalk-app-text-muted)]" role="status">
        No active screen share
      </div>
    );
  return <ScreenShareViewSurface {...props} screenShareTrack={active.screenShareTrack} sharedByName={active.displayName} />;
}
