import { createSpaceClient, type AccessGrant, type SpaceClient, type SpaceSnapshot } from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform } from "@q9labsai/chalk-client/effect";
import { Chalk } from "@q9labsai/chalk-react";
import { createRoot } from "react-dom/client";

import { bindFixtureMediaClient, FixtureMediaClient } from "./media-client";
import { fixtureClock, fixtureMediaDevices, resourceCounts } from "./resource-ledger";
import { bindFixtureSyncClient, FixtureSyncClient } from "./sync-client";

type Harness = {
  readonly join: SpaceClient["join"];
  readonly leave: SpaceClient["leave"];
  readonly dispose: SpaceClient["dispose"];
  readonly setCameraEnabled: SpaceClient["media"]["setCameraEnabled"];
  readonly setMicrophoneEnabled: SpaceClient["media"]["setMicrophoneEnabled"];
  readonly startScreenShare: () => Promise<void>;
  readonly stopScreenShare: () => Promise<void>;
  readonly removeParticipant: SpaceClient["participants"]["remove"];
  readonly sendReaction: SpaceClient["reactions"]["send"];
  readonly sendChatMessage: SpaceClient["chat"]["send"];
  readonly requestUnmute: (participantId: string) => ReturnType<SpaceClient["participants"]["requestMedia"]>;
  readonly requestStartCamera: (participantId: string) => ReturnType<SpaceClient["participants"]["requestMedia"]>;
  readonly declineMediaRequest: SpaceClient["media"]["declineRequest"];
  readonly setHandRaised: (raised: boolean) => Promise<void>;
  readonly setDisplayName: SpaceClient["participants"]["renameSelf"];
  readonly snapshot: () => ReturnType<typeof publicSnapshot>;
  readonly resources: typeof resourceCounts;
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
const createFixtureSpaceClient: typeof createSpaceClient = (options) =>
  createSpaceClientForPlatform(options, {
    apiBaseUrl: location.origin,
    syncUrl: `${socketBaseURL}/sync`,
    dependencies: {
      clock: fixtureClock,
      mediaDevices: fixtureMediaDevices,
      createMediaClient: (input) => bindFixtureMediaClient(new FixtureMediaClient(`${socketBaseURL}/media`, input)),
      createSyncClient: (input) => bindFixtureSyncClient(new FixtureSyncClient(`${socketBaseURL}/sync`, input)),
    },
  });

const client = createFixtureSpaceClient({
  space: "fixture-space",
  baseUrl: location.origin,
  getAccess: async (context) => {
    accessRequests += 1;
    const accessURL = fixtureUser ? `/api/chalk/access?fixtureUser=${encodeURIComponent(fixtureUser)}` : "/api/chalk/access";
    const response = await fetch(accessURL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(context),
    });
    if (!response.ok) throw new TypeError(`Fixture access request failed with HTTP ${response.status}`);
    return (await response.json()) as AccessGrant;
  },
});

function installHarness(nextClient: SpaceClient): void {
  window.__chalk = {
    join: () => joinFromHarness(nextClient),
    leave: nextClient.leave,
    dispose: () => nextClient.dispose(),
    setCameraEnabled: nextClient.media.setCameraEnabled,
    setMicrophoneEnabled: nextClient.media.setMicrophoneEnabled,
    startScreenShare: () => nextClient.media.setScreenShareEnabled(true),
    stopScreenShare: () => nextClient.media.setScreenShareEnabled(false),
    removeParticipant: nextClient.participants.remove,
    sendReaction: nextClient.reactions.send,
    sendChatMessage: nextClient.chat.send,
    requestUnmute: (participantId) => nextClient.participants.requestMedia(participantId, "microphone"),
    requestStartCamera: (participantId) => nextClient.participants.requestMedia(participantId, "camera"),
    declineMediaRequest: nextClient.media.declineRequest,
    setHandRaised: (raised) => (raised ? nextClient.participants.raiseHand() : nextClient.participants.lowerHand()),
    setDisplayName: nextClient.participants.renameSelf,
    snapshot: () => publicSnapshot(nextClient.getSnapshot()),
    resources: resourceCounts,
    accessRequests: () => accessRequests,
  };
}

type HarnessConnection = SpaceSnapshot["connection"];
type JoinAction = (nextClient: SpaceClient, connection: HarnessConnection) => Promise<void>;

const joinActions: Partial<Record<HarnessConnection["status"], JoinAction>> = {
  live: async () => {},
  reconnecting: async () => {},
  joining: (nextClient) => waitForJoin(nextClient),
  failed: (_nextClient, connection) => failJoin(connection.lastError),
};

async function joinFromHarness(nextClient: SpaceClient): Promise<void> {
  const connection = nextClient.getSnapshot().connection;
  const action = joinActions[connection.status];
  if (action) return action(nextClient, connection);
  await nextClient.join();
}

async function failJoin(lastError: HarnessConnection["lastError"]): Promise<void> {
  throw lastError ?? new Error("The Space could not be joined");
}

function waitForJoin(nextClient: SpaceClient): Promise<void> {
  return new Promise((resolveJoin, rejectJoin) => {
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      const { connection } = nextClient.getSnapshot();
      if (connection.status === "joining") return;
      unsubscribe?.();
      settleJoin(connection, resolveJoin, rejectJoin);
    };
    unsubscribe = nextClient.subscribe(finish);
    finish();
  });
}

function settleJoin(connection: HarnessConnection, resolveJoin: () => void, rejectJoin: (error: unknown) => void): void {
  if (connection.status === "live" || connection.status === "reconnecting") resolveJoin();
  else rejectJoin(connection.lastError ?? new Error("The Space could not be joined"));
}

installHarness(client);

createRoot(document.getElementById("root")!).render(<Chalk client={client} entrance={false} displayName={fixtureUser ?? "Packed user"} spaceName="Packed SDK consumer" features={{ chat: true, participants: true, screenShare: true, reactions: true, handRaise: true }} />);

function publicSnapshot(snapshot: SpaceSnapshot) {
  return {
    state: snapshot.connection.status,
    connection: snapshot.connection,
    participants: snapshot.participants.roster.map((participant) => participant.participantId),
    localMedia: Object.fromEntries(Object.entries(snapshot.media.local).map(([source, media]) => [source, { state: media.state, readyState: media.track?.readyState ?? null }])),
    remoteMedia: snapshot.media.remote.map((media) => ({ participantId: media.participantId, source: media.source, readyState: media.track.readyState })),
    reactions: snapshot.reactions.active,
    chat: snapshot.chat,
    incomingMediaRequests: snapshot.media.incomingRequests,
    failure: snapshot.connection.lastError,
  };
}
