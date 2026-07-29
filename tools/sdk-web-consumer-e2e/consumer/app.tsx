import { ChalkSession, requireParticipantAccess, type ChalkSessionAccessRequest, type ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { ChalkProvider, useChalkActions, useChalkSnapshot } from "@q9labsai/chalk-react";
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";

import { FixtureMediaClient } from "./media-client";
import { fixtureClock, fixtureMediaDevices, resourceCounts } from "./resource-ledger";
import { FixtureSyncClient } from "./sync-client";

type Harness = {
  readonly join: () => Promise<void>;
  readonly leave: () => Promise<void>;
  readonly setCameraEnabled: (enabled: boolean) => Promise<void>;
  readonly setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  readonly startScreenShare: () => Promise<void>;
  readonly stopScreenShare: () => Promise<void>;
  readonly removeParticipant: (participantSessionId: string) => Promise<void>;
  readonly sendReaction: ReturnType<typeof useChalkActions>["sendReaction"];
  readonly sendChatMessage: ReturnType<typeof useChalkActions>["sendChatMessage"];
  readonly requestUnmute: ReturnType<typeof useChalkActions>["requestUnmute"];
  readonly requestStartCamera: ReturnType<typeof useChalkActions>["requestStartCamera"];
  readonly declineMediaRequest: ReturnType<typeof useChalkActions>["declineMediaRequest"];
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

function Meeting(): React.JSX.Element {
  const snapshot = useChalkSnapshot();
  const actions = useChalkActions();

  useEffect(() => {
    window.__chalk = {
      ...actions,
      snapshot: () => publicSnapshot(session.getSnapshot()),
      resources: resourceCounts,
      diagnostics: () => session.getDiagnostics(),
      accessRequests: () => accessRequests,
    };
    return () => {
      delete window.__chalk;
    };
  }, [actions]);

  return (
    <main>
      <h1>Packed Chalk SDK consumer</h1>
      <button data-testid="join" onClick={() => void actions.join()}>
        Join
      </button>
      <button data-testid="send-chat" onClick={() => void actions.sendChatMessage({ clientMessageId: "helium-chat", text: "Hello from Helium" })}>
        Send chat
      </button>
      <button data-testid="send-reaction" onClick={() => void actions.sendReaction("🎉")}>
        React
      </button>
      <button data-testid="request-unmute" onClick={() => void actions.requestUnmute("bob")}>
        Ask Bob to unmute
      </button>
      <button data-testid="request-camera" onClick={() => void actions.requestStartCamera("bob")}>
        Ask Bob to start camera
      </button>
      <button data-testid="decline-request" onClick={() => snapshot.incomingMediaRequests[0] && actions.declineMediaRequest(snapshot.incomingMediaRequests[0].requestId)}>
        Decline request
      </button>
      <output data-testid="state">{snapshot.state}</output>
      <output data-testid="participants">{snapshot.participants.length}</output>
      <output data-testid="remote-media">{snapshot.remoteMedia.map((item) => `${item.participantSessionId}:${item.source}`).join(",")}</output>
      <output data-testid="room-actions">{snapshot.roomActions.phase}</output>
      <output data-testid="chat">{snapshot.chat.messages.map((message) => `${message.participantSessionId}:${message.text}`).join("|")}</output>
      <output data-testid="reactions">{snapshot.reactions.map((reaction) => `${reaction.participantSessionId}:${reaction.reaction}`).join("|")}</output>
      <output data-testid="requests">{snapshot.incomingMediaRequests.map((request) => `${request.actorParticipantSessionId}:${request.kind}`).join("|")}</output>
    </main>
  );
}

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

createRoot(document.getElementById("root")!).render(
  <ChalkProvider session={session}>
    <Meeting />
  </ChalkProvider>,
);
