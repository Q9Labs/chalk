"use client";

import type { ChalkReaction } from "@q9labsai/chalk-client";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useChalkActions, useChalkSession, useChalkSnapshot, useLocalMedia, useParticipants, useRemoteMedia } from "../../session";
import { toAudioParticipants, toListParticipants, toParticipantNames, toVideoParticipants } from "../../selectors/meeting-room-selectors";
import { cn } from "../../utils/cn";
import { fromWhiteboardWireElement, toWhiteboardCollaborationEvent } from "../../whiteboard/wire-adapters";
import { AudioRenderer } from "../atomic";
import { ChatPanel, CommandErrorAlert, ConnectionLostOverlay, ControlBar, IncomingMediaRequestDialog, InviteModal, LeaveConfirmationDialog, MeetingHeader, ParticipantList, ReactionPicker, ReactionsOverlay, VideoGrid } from "../composite";
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
  const participantNames = useMemo(() => toParticipantNames(participants, localId, displayName), [displayName, localId, participants]);
  const listParticipants = useMemo(() => toListParticipants(tiles, participants, snapshot.participantMedia), [participants, snapshot.participantMedia, tiles]);
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

      <ReactionsOverlay reactions={snapshot.reactions.slice(-6)} />

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

      {incomingRequest ? <IncomingMediaRequestDialog request={incomingRequest} onDecline={() => actions.declineMediaRequest(incomingRequest.requestId)} onAllow={() => void run(() => actions.acceptMediaRequest(incomingRequest.requestId), "Media request failed")} /> : null}

      <CommandErrorAlert message={commandError || (snapshot.state === "live" ? snapshot.failure?.message : undefined)} />
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
