"use client";

import type { ChalkParticipant, ChalkReaction, ChalkRemoteMedia, ChalkWhiteboardV1Element, ChalkWhiteboardV1Event } from "@q9labsai/chalk-client";
import type { WhiteboardCollaborationEvent, WhiteboardWireElement } from "@q9labsai/chalk-whiteboard";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useChalkActions, useChalkSession, useChalkSnapshot, useLocalMedia, useParticipants, useRemoteMedia } from "../../session";
import { cn } from "../../utils/cn";
import { AudioRenderer } from "../atomic";
import { ChatPanel, ConnectionLostOverlay, ControlBar, InviteModal, LeaveConfirmationDialog, MeetingHeader, ParticipantList, ReactionPicker, VideoGrid } from "../composite";
import type { Participant } from "../composite";
import { uploadChatAttachment } from "../composite/chat-file-upload";
import { WhiteboardPanel } from "./WhiteboardPanel";

const ROOM_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const satisfies readonly ChalkReaction[];

export interface MeetingRoomProps {
  readonly roomName: string;
  readonly displayName: string;
  readonly meetingLink?: string;
  readonly onLeave?: () => void | Promise<void>;
  readonly className?: string;
}

export function MeetingRoom({ roomName, displayName, meetingLink, onLeave, className }: MeetingRoomProps): React.JSX.Element {
  const snapshot = useChalkSnapshot();
  const participants = useParticipants();
  const localMedia = useLocalMedia();
  const remoteMedia = useRemoteMedia();
  const actions = useChalkActions();
  const session = useChalkSession();
  const started = useRef(false);
  const [duration, setDuration] = useState(0);
  const [layout, setLayout] = useState<"grid" | "spotlight" | "sidebar">("grid");
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
  const [loadingOlderChat, setLoadingOlderChat] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [commandError, setCommandError] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void actions.join().catch(() => undefined);
  }, [actions]);

  useEffect(() => {
    if (snapshot.state !== "live") return;
    const interval = window.setInterval(() => setDuration((value) => value + 1), 1_000);
    return () => window.clearInterval(interval);
  }, [snapshot.state]);

  useEffect(() => {
    const whiteboard = session.whiteboard;
    if (!whiteboardOpen || !whiteboard) return;

    let active = true;
    void whiteboard.startSceneSubscription().catch((cause: unknown) => {
      if (active) setCommandError(cause instanceof Error ? cause.message : "Whiteboard connection failed");
    });
    return () => {
      active = false;
      whiteboard.stopSceneSubscription();
    };
  }, [session.whiteboard, whiteboardOpen]);

  const localId = snapshot.subject?.participantSessionId ?? "local";
  const tiles = useMemo(() => toVideoParticipants(participants, remoteMedia, localId, displayName, localMedia), [displayName, localId, localMedia, participants, remoteMedia]);
  const audioParticipants = useMemo(() => toAudioParticipants(remoteMedia), [remoteMedia]);
  const participantNames = useMemo(
    () => Object.fromEntries([...participants.map((participant) => [participant.participantSessionId, participant.displayName] as const), [localId, participants.find((participant) => participant.participantSessionId === localId)?.displayName ?? displayName]]),
    [displayName, localId, participants],
  );
  const listParticipants = useMemo(
    () =>
      tiles.map((participant) => {
        const media = snapshot.participantMedia[participant.id];
        return {
          id: participant.id,
          displayName: participant.displayName,
          isLocal: participant.isLocal,
          isMuted: media?.microphone === "active" ? false : media?.microphone === "inactive" ? true : participant.isMuted,
          isVideoEnabled: media?.camera === "active" ? true : media?.camera === "inactive" ? false : participant.isVideoEnabled,
          isHandRaised: participant.isHandRaised,
          role: toListRole(participants.find((candidate) => candidate.participantSessionId === participant.id)?.role),
        };
      }),
    [participants, snapshot.participantMedia, tiles],
  );
  const microphoneEnabled = localMedia.microphone.state === "enabled" || localMedia.microphone.state === "requesting";
  const cameraEnabled = localMedia.camera.state === "enabled" || localMedia.camera.state === "requesting";
  const screenSharing = localMedia.screen.state === "enabled" || localMedia.screen.state === "requesting";
  const localParticipant = participants.find((participant) => participant.participantSessionId === localId);
  const handRaised = localParticipant?.handRaised ?? false;
  const effectiveLayout = screenSharing || tiles.some((participant) => participant.isScreenSharing) ? "screen-share" : layout;
  const localCapabilities = localParticipant?.capabilities ?? [];
  const canRequestMedia = localCapabilities.includes("requestMediaOthers");
  const canManageParticipants = localCapabilities.some((capability) => ["muteOthers", "stopVideoOthers", "removeParticipant", "promoteDemote", "transferHost"].includes(capability));
  const canChat = snapshot.roomActions.phase === "healthy" && snapshot.roomActions.capabilities.includes("sendChat");
  const canReact = snapshot.roomActions.phase === "healthy" && snapshot.roomActions.capabilities.includes("sendReaction");
  const canUseWhiteboard = session.whiteboard !== null;
  const chatFiles = snapshot.roomActions.phase === "healthy" && snapshot.roomActions.version === 2 ? session.chatFiles : null;
  const incomingRequest = snapshot.incomingMediaRequests[0];

  const run = async (operation: () => Promise<unknown>, fallback: string) => {
    try {
      await operation();
      setCommandError("");
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : fallback);
    }
  };
  const confirmLeave = async () => {
    setLeaveOpen(false);
    try {
      await actions.leave();
    } catch (cause) {
      setCommandError(cause instanceof Error ? cause.message : "The meeting could not confirm your leave");
    } finally {
      await onLeave?.();
    }
  };
  const copyLink = async () => {
    if (meetingLink) await navigator.clipboard.writeText(meetingLink);
  };
  const loadOlderChat = async () => {
    setLoadingOlderChat(true);
    try {
      await actions.loadOlderChatMessages();
    } finally {
      setLoadingOlderChat(false);
    }
  };
  const togglePanel = (panel: "chat" | "participants") => {
    setChatOpen(panel === "chat" ? (value) => !value : false);
    setParticipantsOpen(panel === "participants" ? (value) => !value : false);
  };

  return (
    <main data-chalk data-chalk-theme="dark" className={cn("chalk-root dark relative flex h-dvh min-h-[620px] flex-col overflow-hidden bg-background text-foreground", className)}>
      <AudioRenderer participants={audioParticipants} />
      <MeetingHeader roomName={roomName} duration={duration} layout={layout} onLayoutChange={setLayout} onInvite={() => setInviteOpen(true)} className="relative z-20 shrink-0" />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-28 sm:px-5">
        <section className="min-w-0 flex-1 overflow-hidden rounded-[1.75rem] bg-[var(--chalk-bg-stage)] p-2 shadow-inner sm:p-3" aria-label="Meeting stage">
          {whiteboardOpen && session.whiteboard ? (
            <WhiteboardPanel
              canDraw={snapshot.whiteboard.canDraw}
              collab={{
                canDraw: snapshot.whiteboard.canDraw,
                subscribe: (listener) => session.whiteboard!.subscribe((event) => listener(toWhiteboardCollaborationEvent(event))),
                submitUpdate: async (input) =>
                  session.whiteboard!.submitUpdate({
                    sceneId: input.sceneId,
                    syncAll: input.syncAll,
                    elements: input.elements.map(fromWhiteboardWireElement),
                  }),
                sendCursor: (input) => session.whiteboard!.sendCursor(input),
                requestSnapshot: () => session.whiteboard!.requestSnapshot(),
                clear: () => session.whiteboard!.clear(),
                initiateUpload: (input) => session.whiteboard!.files.initiateUpload(input),
                finalizeUpload: (uploadId) => session.whiteboard!.files.finalizeUpload(uploadId),
                presignDownload: async (fileId) => session.whiteboard!.files.getDownloadUrl(fileId),
              }}
            />
          ) : (
            <VideoGrid participants={tiles} layout={effectiveLayout} className="h-full" />
          )}
        </section>
        {participantsOpen && (
          <aside className="absolute inset-x-3 top-20 bottom-24 z-40 overflow-hidden rounded-[1.5rem] border border-border bg-card shadow-2xl md:static md:block md:w-[340px] md:shrink-0">
            <ParticipantList
              participants={listParticipants}
              variant="sidebar"
              onClose={() => setParticipantsOpen(false)}
              searchable
              canManageParticipants={canManageParticipants || canRequestMedia}
              onMuteParticipant={localCapabilities.includes("muteOthers") ? (id) => void run(() => actions.muteParticipant(id), "Mute failed") : undefined}
              onRequestUnmute={canRequestMedia ? (id) => void run(() => actions.requestUnmute(id), "Unmute request failed") : undefined}
              onStopParticipantCamera={localCapabilities.includes("stopVideoOthers") ? (id) => void run(() => actions.stopParticipantCamera(id), "Camera stop failed") : undefined}
              onRequestStartCamera={canRequestMedia ? (id) => void run(() => actions.requestStartCamera(id), "Camera request failed") : undefined}
              onRemoveParticipant={localCapabilities.includes("removeParticipant") ? (id) => void run(() => actions.removeParticipant(id), "Remove failed") : undefined}
              onMakeHost={localCapabilities.includes("transferHost") ? (id) => void run(() => actions.transferHost(id), "Host transfer failed") : undefined}
              onMakeCoHost={localCapabilities.includes("promoteDemote") ? (id) => void run(() => actions.setParticipantRole(id, "cohost"), "Role update failed") : undefined}
            />
          </aside>
        )}
        {chatOpen && canChat ? (
          <aside className="absolute inset-x-3 top-20 bottom-24 z-40 overflow-hidden rounded-[1.5rem] border border-border bg-card shadow-2xl md:static md:block md:w-[360px] md:shrink-0">
            <ChatPanel
              messages={snapshot.chat.messages}
              pendingMessages={snapshot.chat.pending}
              readReceipts={snapshot.chat.readReceipts}
              localReadThroughSequence={snapshot.chat.localReadThroughSequence}
              participantNames={participantNames}
              localParticipantId={localId}
              hasOlder={snapshot.chat.hasOlder}
              loadingOlder={loadingOlderChat}
              error={snapshot.chat.error?.message}
              onClose={() => setChatOpen(false)}
              onSendMessage={async ({ text, attachments }) => {
                await actions.sendChatMessage({ text, attachments });
              }}
              onUploadAttachment={chatFiles ? (file) => uploadChatAttachment(file, chatFiles) : undefined}
              onResolveAttachmentUrl={chatFiles ? async (attachmentId) => (await chatFiles.getDownloadUrl(attachmentId)).downloadUrl : undefined}
              onMarkRead={async (throughSequence) => {
                await actions.markChatRead(throughSequence);
              }}
              onRetryMessage={async (id) => {
                await actions.retryChatMessage(id);
              }}
              onLoadOlder={loadOlderChat}
            />
          </aside>
        ) : null}
      </div>

      <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-live="polite" aria-atomic="false">
        {snapshot.reactions.slice(-6).map((reaction, index) => (
          <div key={reaction.eventId} className="absolute bottom-28 rounded-full bg-card/90 px-3 py-2 text-2xl shadow-xl" style={{ left: `${18 + index * 12}%` }}>
            <span aria-hidden="true">{reaction.reaction}</span>
            <span className="sr-only">
              {reaction.displayName} reacted {reaction.reaction}
            </span>
          </div>
        ))}
      </div>

      <div className="absolute inset-x-0 bottom-0 z-30 hidden px-5 md:block">
        <ControlBar
          variant="dock"
          meetingDuration={duration}
          buttons={["mic", "video", "screenshare", ...(canUseWhiteboard ? (["whiteboard"] as const) : []), "handraise", "leave", "participants", ...(canChat ? (["chat"] as const) : []), ...(canReact ? (["reactions"] as const) : [])]}
          isMuted={!microphoneEnabled}
          isVideoEnabled={cameraEnabled}
          isScreenSharing={screenSharing}
          isHandRaised={handRaised}
          isParticipantsOpen={participantsOpen}
          isChatOpen={chatOpen}
          isWhiteboardOpen={whiteboardOpen}
          unreadChatCount={snapshot.chat.unreadCount}
          onToggleMute={() => void run(() => actions.setMicrophoneEnabled(!microphoneEnabled), "Microphone update failed")}
          onToggleVideo={() => void run(() => actions.setCameraEnabled(!cameraEnabled), "Camera update failed")}
          onToggleScreenShare={() => void run(() => (screenSharing ? actions.stopScreenShare() : actions.startScreenShare()), "Screen sharing update failed")}
          onToggleHandRaise={() => void run(() => actions.setHandRaised(!handRaised), "Hand raise update failed")}
          onToggleParticipants={() => togglePanel("participants")}
          onToggleChat={canChat ? () => togglePanel("chat") : undefined}
          onOpenReactions={canReact ? () => setReactionPickerOpen(true) : undefined}
          onToggleWhiteboard={canUseWhiteboard ? () => setWhiteboardOpen((value) => !value) : undefined}
          onLeave={() => setLeaveOpen(true)}
          participantColorSeed={displayName}
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 z-30 md:hidden">
        <ControlBar
          variant="mobile"
          buttons={["mic", "video", ...(canUseWhiteboard ? (["whiteboard"] as const) : []), "handraise", "leave", "participants", ...(canChat ? (["chat"] as const) : []), ...(canReact ? (["reactions"] as const) : [])]}
          isMuted={!microphoneEnabled}
          isVideoEnabled={cameraEnabled}
          isHandRaised={handRaised}
          isParticipantsOpen={participantsOpen}
          isChatOpen={chatOpen}
          isWhiteboardOpen={whiteboardOpen}
          unreadChatCount={snapshot.chat.unreadCount}
          onToggleMute={() => void run(() => actions.setMicrophoneEnabled(!microphoneEnabled), "Microphone update failed")}
          onToggleVideo={() => void run(() => actions.setCameraEnabled(!cameraEnabled), "Camera update failed")}
          onToggleHandRaise={() => void run(() => actions.setHandRaised(!handRaised), "Hand raise update failed")}
          onToggleParticipants={() => togglePanel("participants")}
          onToggleChat={canChat ? () => togglePanel("chat") : undefined}
          onToggleWhiteboard={canUseWhiteboard ? () => setWhiteboardOpen((value) => !value) : undefined}
          onOpenReactions={canReact ? () => setReactionPickerOpen(true) : undefined}
          onLeave={() => setLeaveOpen(true)}
        />
      </div>

      {canReact ? (
        <div className="absolute bottom-24 left-1/2 z-50">
          <ReactionPicker isOpen={reactionPickerOpen} onClose={() => setReactionPickerOpen(false)} allowedReactions={ROOM_REACTIONS} onSelect={(reaction) => void run(() => actions.sendReaction(reaction as ChalkReaction), "Reaction failed")} size="compact" />
        </div>
      ) : null}

      {incomingRequest ? (
        <div role="dialog" aria-modal="true" aria-label={incomingRequest.kind === "unmute" ? "Unmute request" : "Camera request"} className="absolute bottom-24 left-1/2 z-50 w-[min(92vw,380px)] -translate-x-1/2 rounded-2xl border border-border bg-popover p-5 shadow-2xl">
          <p className="font-semibold">
            {incomingRequest.actorDisplayName ?? "A meeting moderator"} is asking you to {incomingRequest.kind === "unmute" ? "unmute" : "start your camera"}.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted" onClick={() => actions.declineMediaRequest(incomingRequest.requestId)}>
              Not now
            </button>
            <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" onClick={() => void run(() => actions.acceptMediaRequest(incomingRequest.requestId), "Media request failed")}>
              Allow
            </button>
          </div>
        </div>
      ) : null}

      {(commandError || (snapshot.state === "live" && snapshot.failure)) && (
        <p role="alert" className="absolute bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-full border border-destructive/30 bg-destructive/15 px-4 py-2 text-sm text-destructive backdrop-blur">
          {commandError || snapshot.failure?.message}
        </p>
      )}
      <ConnectionLostOverlay
        isVisible={snapshot.state === "joining" || snapshot.state === "reconnecting" || snapshot.state === "failed"}
        status={snapshot.state === "failed" ? "failed" : snapshot.state === "reconnecting" ? "reconnecting" : "connecting"}
        message={snapshot.failure?.message}
        onRetry={snapshot.state === "failed" && snapshot.failure?.recoverable ? () => void actions.join() : undefined}
        onLeave={() => void confirmLeave()}
      />
      <InviteModal isOpen={inviteOpen} onClose={() => setInviteOpen(false)} meetingLink={meetingLink ?? ""} onCopyLink={meetingLink ? copyLink : undefined} />
      <LeaveConfirmationDialog isOpen={leaveOpen} onClose={() => setLeaveOpen(false)} onConfirm={() => void confirmLeave()} />
    </main>
  );
}

function toVideoParticipants(participants: readonly ChalkParticipant[], remoteMedia: readonly ChalkRemoteMedia[], localId: string, displayName: string, localMedia: ReturnType<typeof useLocalMedia>): Participant[] {
  const remoteByParticipant = new Map<string, Partial<Record<"camera" | "screen", MediaStreamTrack>>>();
  for (const publication of remoteMedia) {
    if (publication.source === "microphone") continue;
    const media = remoteByParticipant.get(publication.participantSessionId) ?? {};
    media[publication.source] = publication.track;
    remoteByParticipant.set(publication.participantSessionId, media);
  }
  const localFromSync = participants.find((participant) => participant.participantSessionId === localId);
  const result: Participant[] = [
    {
      id: localId,
      displayName: localFromSync?.displayName || displayName,
      isLocal: true,
      isMuted: localMedia.microphone.state !== "enabled",
      isVideoEnabled: localMedia.camera.state === "enabled" || localMedia.screen.state === "enabled",
      isScreenSharing: localMedia.screen.state === "enabled",
      isHandRaised: localFromSync?.handRaised,
      videoTrack: localMedia.camera.track,
      screenShareTrack: localMedia.screen.track,
    },
  ];
  for (const participant of participants) {
    if (participant.participantSessionId === localId) continue;
    const media = remoteByParticipant.get(participant.participantSessionId);
    result.push({
      id: participant.participantSessionId,
      displayName: participant.displayName,
      isMuted: !remoteMedia.some((publication) => publication.participantSessionId === participant.participantSessionId && publication.source === "microphone"),
      isVideoEnabled: Boolean(media?.camera || media?.screen),
      isScreenSharing: Boolean(media?.screen),
      isHandRaised: participant.handRaised,
      videoTrack: media?.camera,
      screenShareTrack: media?.screen,
    });
  }
  return result;
}

function toAudioParticipants(remoteMedia: readonly ChalkRemoteMedia[]) {
  const byParticipant = new Map<string, { id: string; audioTrack?: MediaStreamTrack; screenShareAudioTrack?: MediaStreamTrack }>();
  for (const publication of remoteMedia) {
    if (publication.track.kind !== "audio") continue;
    const participant = byParticipant.get(publication.participantSessionId) ?? { id: publication.participantSessionId };
    if (publication.source === "microphone") participant.audioTrack = publication.track;
    if (publication.source === "screen") participant.screenShareAudioTrack = publication.track;
    byParticipant.set(publication.participantSessionId, participant);
  }
  return [...byParticipant.values()];
}

function toListRole(role: ChalkParticipant["role"] | undefined): "host" | "co-host" | "participant" {
  return role === "cohost" ? "co-host" : (role ?? "participant");
}

function fromWhiteboardWireElement(element: { readonly id: string; readonly type: string; readonly version: number; readonly version_nonce: number; readonly index: string; readonly is_deleted: boolean; readonly payload: ChalkWhiteboardV1Element["payload"] }): ChalkWhiteboardV1Element {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    versionNonce: element.version_nonce,
    index: element.index,
    isDeleted: element.is_deleted,
    payload: element.payload,
  };
}

function toWhiteboardWireElement(element: ChalkWhiteboardV1Element): WhiteboardWireElement {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    version_nonce: element.versionNonce,
    index: element.index,
    is_deleted: element.isDeleted,
    payload: element.payload,
  };
}

function toWhiteboardCollaborationEvent(event: ChalkWhiteboardV1Event): WhiteboardCollaborationEvent {
  if (event.type === "snapshot") {
    return {
      ...event,
      elements: event.elements.map(toWhiteboardWireElement),
    };
  }
  if (event.type === "update") {
    return {
      ...event,
      elements: event.elements.map(toWhiteboardWireElement),
    };
  }
  return event;
}
