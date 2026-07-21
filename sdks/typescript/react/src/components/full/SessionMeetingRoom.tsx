"use client";

import type { ChalkParticipant, ChalkRemoteMedia } from "@q9labsai/chalk-client";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useChalkActions, useChalkSnapshot, useLocalMedia, useParticipants, useRemoteMedia } from "../../session";
import { cn } from "../../utils/cn";
import { ConnectionLostOverlay, ControlBar, InviteModal, LeaveConfirmationDialog, MeetingHeader, ParticipantList, VideoGrid } from "../composite";
import type { Participant } from "../composite";

export interface SessionMeetingRoomProps {
  readonly roomName: string;
  readonly displayName: string;
  readonly meetingLink?: string;
  readonly onLeave?: () => void | Promise<void>;
  readonly className?: string;
}

export function SessionMeetingRoom({ roomName, displayName, meetingLink, onLeave, className }: SessionMeetingRoomProps): React.JSX.Element {
  const snapshot = useChalkSnapshot();
  const participants = useParticipants();
  const localMedia = useLocalMedia();
  const remoteMedia = useRemoteMedia();
  const actions = useChalkActions();
  const started = useRef(false);
  const [duration, setDuration] = useState(0);
  const [layout, setLayout] = useState<"grid" | "spotlight" | "sidebar">("grid");
  const [participantsOpen, setParticipantsOpen] = useState(false);
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

  const localId = snapshot.subject?.participantSessionId ?? "local";
  const tiles = useMemo(() => toVideoParticipants(participants, remoteMedia, localId, displayName, localMedia), [displayName, localId, localMedia, participants, remoteMedia]);
  const listParticipants = useMemo(
    () =>
      tiles.map((participant) => ({
        id: participant.id,
        displayName: participant.displayName,
        isLocal: participant.isLocal,
        isMuted: participant.isMuted,
        isVideoEnabled: participant.isVideoEnabled,
        isHandRaised: participant.isHandRaised,
        role: toListRole(participants.find((candidate) => candidate.participantSessionId === participant.id)?.role),
      })),
    [participants, tiles],
  );
  const microphoneEnabled = localMedia.microphone.state === "enabled" || localMedia.microphone.state === "requesting";
  const cameraEnabled = localMedia.camera.state === "enabled" || localMedia.camera.state === "requesting";
  const screenSharing = localMedia.screen.state === "enabled" || localMedia.screen.state === "requesting";
  const localParticipant = participants.find((participant) => participant.participantSessionId === localId);
  const handRaised = localParticipant?.handRaised ?? false;
  const effectiveLayout = screenSharing || tiles.some((participant) => participant.isScreenSharing) ? "screen-share" : layout;

  const run = async (operation: () => Promise<void>, fallback: string) => {
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

  return (
    <main data-chalk data-chalk-theme="dark" className={cn("chalk-root dark relative flex h-dvh min-h-[620px] flex-col overflow-hidden bg-background text-foreground", className)}>
      <MeetingHeader roomName={roomName} duration={duration} layout={layout} onLayoutChange={setLayout} onInvite={() => setInviteOpen(true)} className="relative z-20 shrink-0" />
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-28 sm:px-5">
        <section className="min-w-0 flex-1 overflow-hidden rounded-[1.75rem] bg-[var(--chalk-bg-stage)] p-2 shadow-inner sm:p-3" aria-label="Meeting stage">
          <VideoGrid participants={tiles} layout={effectiveLayout} className="h-full" />
        </section>
        {participantsOpen && (
          <aside className="hidden w-[340px] shrink-0 overflow-hidden rounded-[1.5rem] border border-border bg-card shadow-2xl md:block">
            <ParticipantList participants={listParticipants} variant="sidebar" onClose={() => setParticipantsOpen(false)} searchable />
          </aside>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 z-30 hidden px-5 md:block">
        <ControlBar
          variant="dock"
          meetingDuration={duration}
          buttons={["mic", "video", "screenshare", "handraise", "leave", "participants"]}
          isMuted={!microphoneEnabled}
          isVideoEnabled={cameraEnabled}
          isScreenSharing={screenSharing}
          isHandRaised={handRaised}
          isParticipantsOpen={participantsOpen}
          onToggleMute={() => void run(() => actions.setMicrophoneEnabled(!microphoneEnabled), "Microphone update failed")}
          onToggleVideo={() => void run(() => actions.setCameraEnabled(!cameraEnabled), "Camera update failed")}
          onToggleScreenShare={() => void run(() => (screenSharing ? actions.stopScreenShare() : actions.startScreenShare()), "Screen sharing update failed")}
          onToggleHandRaise={() => void run(() => actions.setHandRaised(!handRaised), "Hand raise update failed")}
          onToggleParticipants={() => setParticipantsOpen((value) => !value)}
          onLeave={() => setLeaveOpen(true)}
          participantColorSeed={displayName}
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 z-30 md:hidden">
        <ControlBar
          variant="mobile"
          isMuted={!microphoneEnabled}
          isVideoEnabled={cameraEnabled}
          isHandRaised={handRaised}
          onToggleMute={() => void run(() => actions.setMicrophoneEnabled(!microphoneEnabled), "Microphone update failed")}
          onToggleVideo={() => void run(() => actions.setCameraEnabled(!cameraEnabled), "Camera update failed")}
          onToggleHandRaise={() => void run(() => actions.setHandRaised(!handRaised), "Hand raise update failed")}
          onLeave={() => setLeaveOpen(true)}
        />
      </div>

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
      isVideoEnabled: localMedia.camera.state === "enabled",
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
      isVideoEnabled: Boolean(media?.camera),
      isScreenSharing: Boolean(media?.screen),
      isHandRaised: participant.handRaised,
      videoTrack: media?.camera,
      screenShareTrack: media?.screen,
    });
  }
  return result;
}

function toListRole(role: ChalkParticipant["role"] | undefined): "host" | "co-host" | "participant" {
  return role === "cohost" ? "co-host" : (role ?? "participant");
}
