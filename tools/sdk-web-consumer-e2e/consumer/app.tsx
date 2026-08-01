import { ChalkSession, requireParticipantAccess, type ChalkSessionAccessRequest, type ChalkSessionActions, type ChalkSessionSnapshot, type ChalkSessionStore } from "@q9labsai/chalk-client";
import { VideoConference } from "@q9labsai/chalk-react";
import { createRoot } from "react-dom/client";

import { FixtureMediaClient } from "./media-client";
import { fixtureClock, fixtureMediaDevices, resourceCounts } from "./resource-ledger";
import { FixtureSyncClient } from "./sync-client";

type Harness = ChalkSessionActions & {
  readonly snapshot: () => ReturnType<typeof publicSnapshot>;
  readonly resources: typeof resourceCounts;
  readonly diagnostics: () => ReturnType<ChalkSession["getDiagnostics"]>;
  readonly accessRequests: () => number;
};

declare global {
  interface Window {
    __chalk?: Harness;
  }
}

let accessRequests = 0;
const socketBaseURL = location.origin.replace(/^http/u, "ws");
const fixtureUser = new URL(location.href).searchParams.get("fixtureUser");
const session = new ChalkSession({
  access: async (request?: ChalkSessionAccessRequest) => {
    accessRequests += 1;
    const accessURL = fixtureUser ? `/api/chalk/access?fixtureUser=${encodeURIComponent(fixtureUser)}` : "/api/chalk/access";
    const response = await fetch(accessURL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(accessRequestBody(request)),
    });
    return requireParticipantAccess(response);
  },
  syncURL: `${socketBaseURL}/sync`,
  apiBaseURL: location.origin,
  accessRefreshWindowMs: 700,
  recovery: { maxAttempts: 3, budgetMs: 4_000, backoffMs: [10, 25, 50] },
  dependencies: {
    clock: fixtureClock,
    mediaDevices: fixtureMediaDevices,
    createMediaClient: (input) => new FixtureMediaClient(`${socketBaseURL}/media`, input),
    createSyncClient: (input) => new FixtureSyncClient(`${socketBaseURL}/sync`, input),
  },
});

function accessRequestBody(request?: ChalkSessionAccessRequest) {
  if (!request) return { reason: "join", replaceMediaConnection: false };
  return {
    reason: request.reason,
    replaceMediaConnection: request.replaceMediaConnection,
    currentMediaToken: request.currentMediaToken,
    expectedParticipantGeneration: request.expectedParticipantGeneration,
  };
}

function installHarness(nextSession: ChalkSessionStore): void {
  window.__chalk = {
    join: nextSession.join,
    leave: nextSession.leave,
    setCameraEnabled: nextSession.setCameraEnabled,
    setMicrophoneEnabled: nextSession.setMicrophoneEnabled,
    startScreenShare: nextSession.startScreenShare,
    stopScreenShare: nextSession.stopScreenShare,
    removeParticipant: nextSession.removeParticipant,
    sendReaction: nextSession.sendReaction,
    sendChatMessage: nextSession.sendChatMessage,
    requestUnmute: nextSession.requestUnmute,
    requestStartCamera: nextSession.requestStartCamera,
    declineMediaRequest: nextSession.declineMediaRequest,
    setHandRaised: nextSession.setHandRaised,
    setDisplayName: nextSession.setDisplayName,
    setAdmissionPolicy: nextSession.setAdmissionPolicy,
    setParticipantRole: nextSession.setParticipantRole,
    transferHost: nextSession.transferHost,
    admitParticipant: nextSession.admitParticipant,
    denyAdmission: nextSession.denyAdmission,
    stopParticipantCamera: nextSession.stopParticipantCamera,
    stopParticipantScreenShare: nextSession.stopParticipantScreenShare,
    muteParticipant: nextSession.muteParticipant,
    endSession: nextSession.endSession,
    retryChatMessage: nextSession.retryChatMessage,
    loadOlderChatMessages: nextSession.loadOlderChatMessages,
    markChatRead: nextSession.markChatRead,
    acceptMediaRequest: nextSession.acceptMediaRequest,
    snapshot: () => publicSnapshot(nextSession.getSnapshot()),
    resources: resourceCounts,
    diagnostics: () => (nextSession instanceof ChalkSession ? nextSession.getDiagnostics() : []),
    accessRequests: () => accessRequests,
  };
}

installHarness(session);

createRoot(document.getElementById("root")!).render(
  <VideoConference roomId="packed-e2e-room" roomName="Packed SDK consumer" userName={fixtureUser ?? "Packed user"} autoJoin createSession={() => session} chatEnabled participantsEnabled screenShareEnabled reactionsEnabled handRaiseEnabled canLeave />,
);

function publicSnapshot(snapshot: ChalkSessionSnapshot) {
  return {
    state: snapshot.state,
    subject: snapshot.subject,
    connection: snapshot.connection,
    participants: snapshot.participants.map((participant) => participant.participantSessionId),
    localMedia: Object.fromEntries(Object.entries(snapshot.localMedia).map(([source, media]) => [source, { state: media.state, readyState: media.track?.readyState ?? null }])),
    remoteMedia: snapshot.remoteMedia.map((media) => ({ participantSessionId: media.participantSessionId, source: media.source, readyState: media.track.readyState })),
    roomActions: snapshot.roomActions,
    reactions: snapshot.reactions,
    chat: snapshot.chat,
    incomingMediaRequests: snapshot.incomingMediaRequests,
    failure: snapshot.failure,
  };
}
