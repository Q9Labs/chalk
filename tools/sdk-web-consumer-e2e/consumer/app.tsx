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
const session = new ChalkSession({
  access: async (request?: ChalkSessionAccessRequest) => {
    accessRequests += 1;
    const response = await fetch("/api/chalk/access", {
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
      <output data-testid="state">{snapshot.state}</output>
      <output data-testid="participants">{snapshot.participants.length}</output>
      <output data-testid="remote-media">{snapshot.remoteMedia.map((item) => `${item.participantSessionId}:${item.source}`).join(",")}</output>
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
    failure: snapshot.failure,
  };
}

createRoot(document.getElementById("root")!).render(
  <ChalkProvider session={session}>
    <Meeting />
  </ChalkProvider>,
);
