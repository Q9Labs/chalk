import { Chalk } from "@q9labsai/chalk-react";
import { useRef, useState } from "react";
import { createCallStateClient, liveSnapshot, PEOPLE, SELF_NAME, SPACE_NAME } from "./fixtures";
import { releaseFakeMedia } from "./media";
import type { CallState } from "./states";

export const PERFORMANCE_STATES: readonly CallState[] = [
  { id: "perf-six", title: "Performance: six cameras", render: () => <PerformanceCall count={6} /> },
  { id: "perf-grid", title: "Performance: 24 cameras", render: () => <PerformanceCall count={24} /> },
  { id: "perf-share", title: "Performance: screen share", render: () => <PerformanceCall count={6} share /> },
  { id: "perf-board", title: "Performance: board", render: () => <PerformanceCall count={6} board /> },
];

type PerfClient = ReturnType<typeof createCallStateClient>;
type PerfControl = readonly [name: string, label: string, run: () => void];

/** The hidden buttons the performance checks click: each changes the fixture client the way a live call would. */
function perfControls({ client, count, updateRoster, rejoin }: { readonly client: PerfClient; readonly count: number; readonly updateRoster: (extra: boolean, sharing?: boolean) => void; readonly rejoin: () => void }): readonly PerfControl[] {
  return [
    ["reconnect", "Reconnect", () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "reconnecting" } }))],
    ["recover", "Recover", () => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live" } }))],
    [
      "reactions",
      "Reaction burst",
      () =>
        client.updateSnapshot((current) => ({
          ...current,
          reactions: { active: Array.from({ length: 24 }, (_, index) => ({ eventId: `burst-${index}`, participantId: `perf-${index % (count - 1)}`, displayName: `Camera ${index + 1}`, reaction: "🎉", occurredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 4_000).toISOString() })) },
        })),
    ],
    [
      "join",
      "Join",
      () => {
        client.updateSnapshot(() => liveSnapshot({ others: Array.from({ length: count - 1 }, (_, index) => ({ id: `perf-${index}`, name: `Camera ${index + 1}` })) }));
        rejoin();
      },
    ],
    ["people-in", "Add person", () => updateRoster(true)],
    ["people-out", "Remove person", () => updateRoster(false)],
    ["share-on", "Start share", () => updateRoster(false, true)],
    ["share-off", "Stop share", () => updateRoster(false)],
    ["board-on", "Open board", () => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, open: true, engine: { ...current.whiteboard.engine, status: "ready", sceneId: "scene-1", revision: "1", presenting: true } } }))],
    ["board-off", "Close board", () => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, open: false, engine: { ...current.whiteboard.engine, presenting: false } } }))],
  ];
}

function PerformanceCall({ count, share = false, board = false }: { readonly count: number; readonly share?: boolean; readonly board?: boolean }) {
  const [client] = useState(() =>
    createCallStateClient(
      liveSnapshot({
        others: Array.from({ length: count - 1 }, (_, index) => ({ ...PEOPLE[index % PEOPLE.length]!, id: `perf-${index}`, name: `Camera ${index + 1}`, sharing: share && index === 0 })),
        board,
      }),
    ),
  );
  const [joined, setJoined] = useState(true);
  const personSequence = useRef(0);
  const [generation, setGeneration] = useState(0);
  const updateRoster = (extra: boolean, sharing = false) => {
    if (extra) personSequence.current++;
    const next = liveSnapshot({ others: Array.from({ length: count - 1 + (extra ? 1 : 0) }, (_, index) => ({ id: extra && index === count - 1 ? `perf-join-${personSequence.current}` : `perf-${index}`, name: `Camera ${index + 1}`, sharing: sharing && index === 0 })) });
    client.updateSnapshot((current) => ({ ...current, participants: next.participants, media: next.media }));
  };
  const controls = perfControls({
    client,
    count,
    updateRoster,
    rejoin: () => {
      setGeneration((value) => value + 1);
      setJoined(true);
    },
  });
  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      {/* Fixture controls stay hidden; Playwright dispatches trusted input to the real call UI separately. */}
      {controls.map(([name, label, run]) => (
        <button key={name} hidden {...{ [`data-perf-${name}`]: "" }} onClick={run}>
          {label}
        </button>
      ))}
      {joined && (
        <Chalk
          key={generation}
          theme={{ colorScheme: "dark" }}
          client={client}
          displayName={SELF_NAME}
          spaceName={SPACE_NAME}
          {...(count === 24 ? { layout: "grid" } : {})}
          onLeft={() => {
            setJoined(false);
            // The preview client has no media engine. Release its snapshot and owned sources here.
            client.updateSnapshot(() => liveSnapshot({ self: { camera: false, microphone: false } }));
            releaseFakeMedia();
          }}
        />
      )}
    </main>
  );
}
