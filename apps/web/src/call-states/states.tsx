import { INTEGRATION_STATES } from "./integration";
import { STAGE_STATES } from "./stage";
import { SHELL_STATES } from "./shell";
import { CARD_STATES } from "./card";
import { ChatJitterState } from "./chat-jitter";
import { STATES_LANE } from "./states-lane";
import { FoundationKit } from "./foundation";
import { readThemePreference, persistThemePreference } from "../lib/theme";
import { PERFORMANCE_STATES } from "./performance";
import { SpaceClientError, type SpaceSnapshot } from "@q9labsai/chalk-client";
import { CallLimbo, Chalk, ToastStack, type SpaceLayout } from "@q9labsai/chalk-react";
import { useEffect, useState, type ReactNode } from "react";
import { NameNeeded } from "../components/space/SpacePage";
import { HOST, PEOPLE, SELF_NAME, SPACE_NAME, chatMessages, createCallStateClient, liveSnapshot, type BoardFixture, type CallStateClient, type Person } from "./fixtures";

/** A step the capture script performs after the state mounts, by accessible role and name. */
export type Action = { readonly click: string; readonly role?: "button" | "menuitemradio" } | { readonly wait: number };

export type CallStateMeta = {
  readonly id: string;
  readonly title: string;
  readonly actions?: readonly Action[];
  /** The capture script holds back the board's stylesheet, so the board stays on its loading screen. */
  readonly stallBoard?: boolean;
  readonly cameraBlocked?: boolean;
};

export type CallState = CallStateMeta & { readonly render: () => ReactNode };

const nora: Person = PEOPLE[0]!;
const akash: Person = PEOPLE[1]!;
const sofia: Person = PEOPLE[2]!;
const malik: Person = PEOPLE[3]!;
const crowd = (count: number): Person[] => Array.from({ length: count }, (_, index) => ({ ...PEOPLE[index % PEOPLE.length]!, id: `p${index}`, name: index < PEOPLE.length ? PEOPLE[index]!.name : `${PEOPLE[index % PEOPLE.length]!.name.split(" ")[0]} ${index}` }));

const openChat: Action = { click: "Chat" };
const openLayout: Action = { click: "Layout: Spotlight" };

export const CALL_STATES: readonly CallState[] = [
  { id: "chat-jitter", title: "Chat: idle three-person call", render: () => <ChatJitterState /> },
  ...PERFORMANCE_STATES,
  ...SHELL_STATES,
  ...STAGE_STATES,
  ...CARD_STATES,
  ...STATES_LANE,
  ...INTEGRATION_STATES,
  { id: "foundation-motion-dark", title: "Foundation motion Dark", render: () => <FoundationKit scheme="dark" initialNotice={false} /> },
  { id: "foundation-motion-light", title: "Foundation motion Light", render: () => <FoundationKit scheme="light" initialNotice={false} /> },
  { id: "foundation-kit-dark", title: "Foundation primitives Dark", render: () => <FoundationKit scheme="dark" /> },
  { id: "foundation-kit-light", title: "Foundation primitives Light", render: () => <FoundationKit scheme="light" /> },
  { id: "foundation-dark", title: "Foundation call Dark", render: () => <Live initialColorScheme="dark" snapshot={liveSnapshot({ others: [nora] })} /> },
  { id: "foundation-light", title: "Foundation call Light", render: () => <Live initialColorScheme="light" snapshot={liveSnapshot({ others: [nora] })} /> },
  {
    id: "foundation-toast",
    title: "Foundation toast announcement",
    render: () => (
      <main data-chalk className="h-dvh">
        <ToastStack toasts={[{ id: "join", message: "Nora joined", duration: Infinity }]} onDismiss={() => undefined} />
      </main>
    ),
  },
  { id: "joining", title: "Joining with devices off", render: () => <Live snapshot={{ ...liveSnapshot(), connection: { status: "joining", episode: null, lastError: null, episodeEnded: false, removedByHost: false } }} /> },
  { id: "name-needed", title: "Name needed", render: () => <JoinName theme="dark" /> },
  { id: "name-needed-light", title: "Name needed, light", render: () => <JoinName theme="light" /> },
  { id: "knocking", title: "Asking the host to join", render: () => <WaitingForHost /> },
  {
    id: "knock-denied",
    title: "Host declined the request",
    render: () => (
      <main className="h-dvh">
        <CallLimbo spaceName={SPACE_NAME} message="The host declined your request to join." action={{ label: "Ask again", onClick: () => undefined }} />
      </main>
    ),
  },
  {
    id: "knock-expired",
    title: "Request expired",
    render: () => (
      <main className="h-dvh">
        <CallLimbo spaceName={SPACE_NAME} message="Your request to join expired or is no longer available." action={{ label: "Ask again", onClick: () => undefined }} />
      </main>
    ),
  },
  { id: "joining-complete", title: "Blur lifting on admission", render: () => <JoiningComplete /> },
  { id: "waiting-for-host", title: "Waiting for the host to let you in", render: () => <WaitingForHost /> },
  { id: "entering", title: "Entering after access is granted", render: () => <Live snapshot={{ ...liveSnapshot(), connection: { status: "joining", episode: null, lastError: null, episodeEnded: false, removedByHost: false } }} /> },

  { id: "solo", title: "Alone in the call", render: () => <Live snapshot={liveSnapshot()} /> },
  { id: "duo", title: "Two people, default layout", render: () => <Live snapshot={liveSnapshot({ others: [nora] })} /> },
  { id: "duo-grid", title: "Two people, grid", render: () => <Live snapshot={liveSnapshot({ others: [nora] })} layout="grid" /> },
  { id: "cameras-off", title: "Two people, both cameras off", render: () => <Live snapshot={liveSnapshot({ self: { camera: false }, others: [{ ...nora, camera: false }] })} /> },
  {
    id: "cues",
    title: "Speaking, muted, hand raised, camera off",
    render: () => (
      <Live
        snapshot={liveSnapshot({
          self: { microphone: false },
          others: [
            { ...nora, speaking: true },
            { ...akash, microphone: false, handRaised: true },
            { ...sofia, camera: false },
          ],
        })}
        layout="grid"
      />
    ),
  },
  { id: "group-spotlight", title: "Ten people, spotlight", render: () => <Live snapshot={liveSnapshot({ others: crowd(9) })} /> },
  { id: "group-grid", title: "Ten people, grid", render: () => <Live snapshot={liveSnapshot({ others: crowd(9) })} layout="grid" /> },
  { id: "crowd-grid", title: "Thirty people, grid with pages", render: () => <Live snapshot={liveSnapshot({ others: crowd(29) })} layout="grid" /> },
  { id: "recording", title: "Recording on", render: () => <Live snapshot={liveSnapshot({ others: [nora], recording: true, capabilities: HOST })} /> },

  { id: "board", title: "Board open", render: () => <Live snapshot={liveSnapshot({ others: [nora], board: true })} /> },
  { id: "board-grid", title: "Board open, grid picked", actions: [openLayout, { click: "Grid", role: "menuitemradio" }], render: () => <Live snapshot={liveSnapshot({ others: [nora], board: true })} /> },
  { id: "board-spotlight", title: "Board open, spotlight picked", actions: [openLayout, { click: "Spotlight", role: "menuitemradio" }], render: () => <Live snapshot={liveSnapshot({ others: [nora], board: true })} /> },
  ...(["dark", "light"] as const).flatMap((scheme) => [
    { id: `board-empty-${scheme}`, title: `Board empty, ${scheme}`, render: () => <Live initialColorScheme={scheme} snapshot={liveSnapshot({ others: [nora], board: true, capabilities: HOST })} /> },
    { id: `board-people-${scheme}`, title: `Board with two people drawing, ${scheme}`, render: () => <Live initialColorScheme={scheme} snapshot={liveSnapshot({ others: [nora, malik], board: true, capabilities: HOST })} board={{ scene: true, people: [nora, malik] }} /> },
    {
      id: `board-notices-${scheme}`,
      title: `Board with three device notices, ${scheme}`,
      render: () => <Live initialColorScheme={scheme} snapshot={liveSnapshot({ others: [nora, malik], board: true, capabilities: HOST })} board={{ scene: true, people: [nora, malik] }} then={raiseDeviceNotices} />,
    },
    { id: `board-share-${scheme}`, title: `Board beside a live share, ${scheme}`, render: () => <Live initialColorScheme={scheme} snapshot={liveSnapshot({ others: [{ ...nora, sharing: true }, malik], board: true, capabilities: HOST })} board={{ scene: true, people: [nora, malik] }} /> },
    {
      id: `board-follow-${scheme}`,
      title: `Board following Nora, ${scheme}`,
      actions: [{ click: "Follow Nora" }],
      render: () => <Live initialColorScheme={scheme} snapshot={liveSnapshot({ others: [nora, malik], board: true, capabilities: HOST })} board={{ scene: true, people: [nora, malik] }} />,
    },
    { id: `board-small-${scheme}`, title: `Board with one small word, ${scheme}`, render: () => <Live initialColorScheme={scheme} snapshot={liveSnapshot({ others: [nora], board: true, capabilities: HOST })} board={{ scene: "small" }} /> },
    { id: `board-relay-${scheme}`, title: `Board shared with other tabs, ${scheme}`, render: () => <Live initialColorScheme={scheme} snapshot={liveSnapshot({ others: [nora], board: true, capabilities: HOST })} board={{ relay: `board-relay-${scheme}` }} /> },
    { id: `board-notes-${scheme}`, title: `Board sticky notes, ${scheme}`, render: () => <Live initialColorScheme={scheme} snapshot={liveSnapshot({ others: [nora, malik], board: true, capabilities: HOST })} board={{ scene: true, people: [nora, malik] }} /> },
  ]),
  { id: "board-loading", title: "Board loading", stallBoard: true, render: () => <Live snapshot={liveSnapshot({ others: [nora], board: true })} /> },
  { id: "share-remote", title: "Someone else shares a screen", render: () => <Live snapshot={liveSnapshot({ others: [{ ...nora, sharing: true }] })} /> },
  { id: "share-local", title: "You share your screen", render: () => <Live snapshot={liveSnapshot({ self: { sharing: true }, others: [nora] })} /> },
  { id: "share-and-board", title: "Screen share and board together", render: () => <Live snapshot={liveSnapshot({ others: [{ ...nora, sharing: true }], board: true })} /> },

  { id: "chat-empty", title: "Chat, no messages", actions: [openChat], render: () => <Live snapshot={liveSnapshot({ others: [nora] })} /> },
  { id: "chat", title: "Chat with messages and a file", actions: [openChat], render: () => <Live snapshot={liveSnapshot({ others: [nora, akash], chat: chatMessages() })} /> },
  {
    id: "participants",
    title: "Participants panel",
    actions: [{ click: "Participants" }],
    render: () => (
      <Live
        snapshot={liveSnapshot({
          others: [
            { ...nora, speaking: true },
            { ...akash, handRaised: true, microphone: false },
            { ...sofia, camera: false },
          ],
        })}
      />
    ),
  },
  { id: "admission", title: "Someone is waiting to be let in", render: () => <Live snapshot={liveSnapshot({ others: [nora], capabilities: HOST, admission: true })} /> },
  { id: "layout-menu", title: "Layout menu", actions: [openLayout], render: () => <Live snapshot={liveSnapshot({ others: [nora] })} /> },
  { id: "device-menu", title: "Microphone menu", actions: [{ click: "Select microphone" }], render: () => <Live snapshot={liveSnapshot({ others: [nora] })} /> },
  { id: "reactions", title: "Reactions", actions: [{ click: "React" }], render: () => <Live snapshot={liveSnapshot({ others: [nora], reactions: true })} /> },
  { id: "leave", title: "Leave, as guest: leaves at once", actions: [{ click: "Leave call" }], render: () => <Live snapshot={liveSnapshot({ others: [nora] })} /> },
  { id: "host-leave", title: "Leave, as host: menu", actions: [{ click: "Leave call" }], render: () => <Live snapshot={liveSnapshot({ others: [nora], capabilities: HOST })} /> },
  { id: "media-request", title: "Asked to unmute", render: () => <Live snapshot={liveSnapshot({ self: { microphone: false }, others: [nora], mediaRequest: true })} /> },
  { id: "command-error", title: "Camera busy error", render: () => <Live snapshot={liveSnapshot({ self: { camera: false }, others: [nora], lastError: { code: "media.device_busy", recoverable: true, message: "Your camera is being used by another app." } })} /> },

  { id: "reconnecting", title: "Reconnecting after the grace period", actions: [{ wait: 2_100 }], render: () => <Live snapshot={liveSnapshot({ others: [nora], status: "reconnecting" })} /> },
  { id: "reconnecting-short", title: "Reconnecting, after 3 seconds", actions: [{ wait: 2_100 }], render: () => <Live snapshot={liveSnapshot({ others: [nora], status: "reconnecting" })} /> },
  { id: "reconnecting-long", title: "Reconnecting, after 10 seconds", actions: [{ wait: 10_500 }], render: () => <Live snapshot={liveSnapshot({ others: [nora], status: "reconnecting" })} /> },
  { id: "offline-actions", title: "Back online with unsent actions", render: () => <Live snapshot={liveSnapshot({ others: [nora], offlinePending: true })} /> },
  {
    id: "hand-peer-toast",
    title: "Your hand is up when Nora raises hers",
    render: () => (
      <Live
        snapshot={liveSnapshot({ self: { handRaised: true }, others: [nora] })}
        then={(client) => client.updateSnapshot((current) => ({ ...current, participants: { ...current.participants, roster: current.participants.roster.map((person) => (person.participantId === nora.id ? { ...person, handRaised: true } : person)) } }))}
      />
    ),
  },
  { id: "failed", title: "Connection lost", render: () => <Live snapshot={liveSnapshot({ others: [nora] })} then={(client) => client.updateSnapshot((current) => withStatus(current, "failed"))} /> },
  { id: "leaving", title: "Leaving", render: () => <Live snapshot={liveSnapshot({ others: [nora], status: "leaving" })} /> },
  { id: "left", title: "Left the call", render: () => <Live snapshot={liveSnapshot({ others: [nora] })} then={(client) => client.updateSnapshot((current) => withStatus(current, "left"))} /> },
  {
    id: "episode-ended",
    title: "Call ended for everyone",
    render: () => (
      <Live
        snapshot={liveSnapshot({ others: [nora] })}
        then={(client) => {
          client.emit("episodeEnded", { episode: client.getSnapshot().connection.episode });
          client.updateSnapshot((current) => withStatus(current, "left"));
        }}
      />
    ),
  },
];

function withStatus(snapshot: SpaceSnapshot, status: SpaceSnapshot["connection"]["status"]): SpaceSnapshot {
  const lastError = status === "failed" ? { code: "connection.sync_recovery_exhausted" as const, recoverable: false, message: "Chalk could not reconnect to this Space." } : null;
  return { ...snapshot, connection: { ...snapshot.connection, status, lastError } };
}

/** Mirrors SpacePage's LocalSpace: the SDK's Chalk root, with the app's own entrance already done. */
function raiseDeviceNotices(client: CallStateClient) {
  for (let index = 0; index < 3; index += 1) client.emit("error", { error: new SpaceClientError({ code: "media.capture_failed", recoverable: true, message: "Your camera could not start." }) });
}

function Live({ snapshot, layout, then, initialColorScheme, board }: { readonly initialColorScheme?: "light" | "dark"; readonly snapshot: SpaceSnapshot; readonly layout?: SpaceLayout; readonly then?: (client: CallStateClient) => void; readonly board?: BoardFixture }) {
  const [client] = useState(() => createCallStateClient(snapshot, board));
  const [colorScheme, setColorScheme] = useState(() => initialColorScheme ?? readThemePreference(document.cookie));
  const [transition] = useState(() => then);
  useEffect(() => {
    if (!transition) return;
    const timer = setTimeout(() => transition(client), 200);
    return () => clearTimeout(timer);
  }, [client, transition]);
  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      <Chalk
        theme={{ colorScheme }}
        onColorSchemeChange={(next) => {
          setColorScheme(next);
          persistThemePreference(next);
        }}
        client={client}
        displayName={SELF_NAME}
        spaceName={SPACE_NAME}
        layout={layout}
        onLeft={() => undefined}
        onHome={() => undefined}
      />
    </main>
  );
}

function WaitingForHost() {
  return (
    <main className="h-dvh">
      <CallLimbo spaceName={SPACE_NAME} message={`Asking to join ${SPACE_NAME}`} detail="The host will let you in." action={{ label: "Cancel", onClick: () => undefined }} />
    </main>
  );
}

function JoinName({ theme }: { readonly theme: "light" | "dark" }) {
  const [name, setName] = useState("");
  return (
    <main data-chalk data-chalk-theme={theme} className="h-dvh">
      <NameNeeded spaceName={SPACE_NAME} theme={theme} displayName={name} onDisplayNameChange={setName} onJoin={() => undefined} />
    </main>
  );
}

function JoiningComplete() {
  const [client] = useState(() => createCallStateClient({ ...liveSnapshot(), connection: { status: "joining", episode: null, lastError: null, episodeEnded: false, removedByHost: false } }));
  return (
    <main className="h-dvh">
      <button hidden data-complete-join onClick={() => client.updateSnapshot(() => liveSnapshot({ self: { camera: false, microphone: false } }))}>
        Complete join
      </button>
      <Chalk client={client} displayName={SELF_NAME} spaceName={SPACE_NAME} />
    </main>
  );
}
