"use client";

import { CHALK_CHAT_ATTACHMENT_MIME_TYPES, type ChatAttachment, type ChatMessage } from "@q9labsai/chalk-client";
import type { RecordingMediaSourceV1, RecordingPresentationParticipantV1, RecordingPresentationSnapshotV1, RecordingSharedContentV1 } from "@q9labsai/recording-presentation";
import type { ReactNode } from "react";

import { ChatPanelPresentation } from "../composite/ChatPanel";
import { ReactionsOverlayPresentation } from "../composite/ReactionsOverlay";
import { ScreenSharePresentation } from "../composite/ScreenShareView";
import { ControlBarPresentation, type ControlBarButtonName } from "../control-bar/ControlBar";
import { ParticipantTileSurface } from "../participant-tile/ParticipantTile";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { QuietSpace } from "../participant-grid/ParticipantGrid";
import { SkinProvider } from "../skin-context";
import { Stage, type StageItem } from "../stage/Stage";
import { StageContentTileSurface } from "../stage/StageContentTile";
import { screenShareItemId, WHITEBOARD_ITEM_ID } from "../stage/stage-items";
import { SpaceDrawer } from "./SpaceDrawer";
import { SpacePresentation } from "./SpacePresentation";

export interface RecordingMediaRenderContext {
  readonly participant: RecordingPresentationParticipantV1;
  readonly placement: "camera" | "shared_content";
}

export interface RecordingSpaceViewProps {
  /** A validated, projected recording_presentation.v1 frame. */
  readonly frame: RecordingPresentationSnapshotV1;
  /** Resolve a visible camera or screen-share source to host-owned decoded media. */
  readonly resolveMedia: (source: RecordingMediaSourceV1, context: RecordingMediaRenderContext) => ReactNode;
  /** Resolve a verified logical asset id; the UI never reads object-store keys. */
  readonly resolveAssetUrl: (assetId: string) => string;
  /** Render the verified whiteboard scene represented by the current frame. */
  readonly renderWhiteboard?: (sharedContent: Extract<RecordingSharedContentV1, { readonly kind: "whiteboard" }>) => ReactNode;
  /** Host-controlled token used to acknowledge a fully presented seek. */
  readonly renderToken?: string;
  readonly className?: string;
}

const RECORDING_TOOLBAR_BUTTONS: ControlBarButtonName[] = ["record", "participants", "chat", "reactions", "whiteboard"];
const CHAT_ATTACHMENT_MIME_TYPES = new Set<string>(CHALK_CHAT_ATTACHMENT_MIME_TYPES);

function hasRenderableMedia(media: ReactNode): boolean {
  return media !== null && media !== undefined && media !== false;
}

function isChatAttachmentMimeType(value: string): value is ChatAttachment["mimeType"] {
  return CHAT_ATTACHMENT_MIME_TYPES.has(value);
}

function toChatMessages(frame: RecordingPresentationSnapshotV1): { readonly messages: ChatMessage[]; readonly displayTimes: ReadonlyMap<string, string>; readonly attachmentAssets: ReadonlyMap<string, string> } {
  const displayTimes = new Map<string, string>();
  const attachmentAssets = new Map<string, string>();
  const messages = frame.chat.messages.map((message): ChatMessage => {
    displayTimes.set(message.id, message.displayTime);
    const attachments = message.attachments.map((attachment): ChatAttachment => {
      if (!isChatAttachmentMimeType(attachment.contentType)) throw new TypeError(`unsupported recording chat attachment content type: ${attachment.contentType}`);
      attachmentAssets.set(attachment.id, attachment.assetId);
      return {
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.contentType,
        byteLength: attachment.byteSize,
      };
    });
    return {
      messageId: message.id,
      clientMessageId: message.id,
      sequence: String(message.sequence),
      participantId: message.participantId,
      displayName: message.displayName,
      text: message.text,
      // The supplied displayTime is authoritative. This stable ISO value only
      // satisfies the shared chat model and is never formatted for presentation.
      createdAt: new Date(message.createdAtMs).toISOString(),
      attachments,
    };
  });
  return { messages, displayTimes, attachmentAssets };
}

function toParticipant(participant: RecordingPresentationParticipantV1, resolveAssetUrl: RecordingSpaceViewProps["resolveAssetUrl"]): Participant {
  return {
    id: participant.id,
    displayName: participant.displayName,
    isSpeaking: participant.speaking,
    isActiveSpeaker: participant.activeSpeaker,
    isMuted: participant.microphoneMuted,
    isVideoEnabled: participant.cameraEnabled,
    isScreenSharing: participant.screenShareEnabled,
    isHandRaised: participant.handRaised,
    avatarUrl: participant.avatarAssetId ? resolveAssetUrl(participant.avatarAssetId) : undefined,
  };
}

export function RecordingSpaceView({ frame, resolveMedia, resolveAssetUrl, renderWhiteboard, renderToken, className }: RecordingSpaceViewProps): React.JSX.Element {
  const sharedContent = frame.sharedContent;
  const joinedParticipants = [...frame.participants.filter((participant) => participant.joined)].sort((left, right) => left.joinOrdinal - right.joinOrdinal || left.id.localeCompare(right.id));
  const recordingParticipantsById = new Map(joinedParticipants.map((participant) => [participant.id, participant]));
  const participantsById = new Map(joinedParticipants.map((participant) => [participant.id, toParticipant(participant, resolveAssetUrl)]));
  const visibleMedia = frame.media.filter((source) => source.visible);
  const mediaNodes = new Map<string, ReactNode>();

  for (const source of visibleMedia) {
    const participant = recordingParticipantsById.get(source.participantId);
    if (!participant) continue;
    mediaNodes.set(source.sourceId, resolveMedia(source, { participant, placement: source.kind === "camera" ? "camera" : "shared_content" }));
  }

  const cameraByParticipant = new Map(visibleMedia.filter((source) => source.kind === "camera").map((source) => [source.participantId, source]));
  const items: StageItem[] = joinedParticipants.map((participant) => ({ kind: "participant", id: participant.id, participant: participantsById.get(participant.id)! }));

  if (sharedContent.kind === "screen_share") {
    const participant = participantsById.get(sharedContent.participantId);
    const source = visibleMedia.find((candidate) => candidate.sourceId === sharedContent.sourceId && candidate.kind === "screen_share");
    if (!participant || !source) throw new TypeError("recording screen share does not resolve to a joined participant and visible source");
    items.push({ kind: "screen-share", id: screenShareItemId(participant.id), participant });
  } else if (sharedContent.kind === "whiteboard") {
    items.push({ kind: "whiteboard", id: WHITEBOARD_ITEM_ID });
  }

  const { messages, displayTimes, attachmentAssets } = toChatMessages(frame);
  const participantNames = Object.fromEntries(frame.participants.map((participant) => [participant.id, participant.displayName]));
  const durationSeconds = Math.floor(frame.elapsedMs / 1_000);

  const renderContent = (item: Extract<StageItem, { readonly kind: "screen-share" | "whiteboard" }>): ReactNode => {
    if (item.kind === "whiteboard") {
      const content = sharedContent.kind === "whiteboard" ? renderWhiteboard?.(sharedContent) : null;
      return <StageContentTileSurface item={item} media={content} mediaVisible={hasRenderableMedia(content)} className="h-full w-full" />;
    }
    if (sharedContent.kind !== "screen_share") throw new TypeError("recording stage contains a screen share without shared-content state");
    const source = visibleMedia.find((candidate) => candidate.sourceId === sharedContent.sourceId);
    if (!source) throw new TypeError("recording screen share source is not visible");
    const media = mediaNodes.get(source.sourceId);
    return <ScreenSharePresentation sharedByName={item.participant.displayName} media={media} mediaVisible={hasRenderableMedia(media)} />;
  };

  return (
    <SkinProvider skin={frame.profile.theme.skin}>
      <SpacePresentation
        skin={frame.profile.theme.skin}
        palette={frame.profile.theme.palette}
        texture={frame.profile.theme.texture}
        stageBackground={frame.profile.theme.stageBackground}
        header={{
          spaceName: frame.space.name,
          logoUrl: frame.space.logoAssetId ? resolveAssetUrl(frame.space.logoAssetId) : undefined,
          duration: durationSeconds,
          isRecording: true,
          layout: frame.view.layout,
        }}
        stage={
          <Stage
            items={items}
            layout={frame.view.layout}
            interactive={false}
            animate={false}
            generatedAvatars={frame.profile.theme.generatedAvatars}
            emptyState={<QuietSpace />}
            renderParticipant={(item, context) => {
              const source = cameraByParticipant.get(item.participant.id);
              const media = source ? mediaNodes.get(source.sourceId) : null;
              return (
                <ParticipantTileSurface
                  participant={item.participant}
                  media={media}
                  mediaVisible={item.participant.isVideoEnabled === true && hasRenderableMedia(media)}
                  aspectRatio="fill"
                  pinned={context.pinned}
                  style={context.style}
                  hidden={context.hidden}
                  generatedAvatars={frame.profile.theme.generatedAvatars}
                  animatedAvatars={false}
                />
              );
            }}
            renderContentTile={(item, context) => {
              const media = item.kind === "whiteboard" && frame.sharedContent.kind === "whiteboard" ? renderWhiteboard?.(frame.sharedContent) : frame.sharedContent.kind === "screen_share" ? mediaNodes.get(frame.sharedContent.sourceId) : null;
              return <StageContentTileSurface item={item} media={media} mediaVisible={hasRenderableMedia(media)} pinned={context.pinned} style={context.style} hidden={context.hidden} />;
            }}
            renderPrimaryContent={renderContent}
            className="h-full"
          />
        }
        controls={<ControlBarPresentation placement="floating" density="comfortable" duration={durationSeconds} buttons={RECORDING_TOOLBAR_BUTTONS} isRecording isChatOpen isWhiteboardOpen={sharedContent.kind === "whiteboard"} expanded detectDevices={false} displayOnly />}
        stageOverlay={<ReactionsOverlayPresentation reactions={frame.reactions} elapsedMs={frame.elapsedMs} />}
        sidebar={
          <SpaceDrawer state="open" interactive={false}>
            <ChatPanelPresentation
              messages={messages}
              participantNames={participantNames}
              onResolveAttachmentUrl={async (attachmentId) => {
                const assetId = attachmentAssets.get(attachmentId);
                if (!assetId) throw new TypeError(`recording chat attachment is unknown: ${attachmentId}`);
                return resolveAssetUrl(assetId);
              }}
              messageDisplayTime={(message) => displayTimes.get(message.messageId) ?? ""}
              autoScrollBehavior="auto"
              generatedAvatars={frame.profile.theme.generatedAvatars}
              stableTexture
              disabled
            />
          </SpaceDrawer>
        }
        renderToken={renderToken}
        interactive={false}
        className={className}
      />
    </SkinProvider>
  );
}

RecordingSpaceView.displayName = "RecordingSpaceView";
