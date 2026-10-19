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
  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      {/* Fixture controls stay hidden; Playwright dispatches trusted input to the real call UI separately. */}
      <button hidden data-perf-reconnect onClick={() => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "reconnecting" } }))}>
        Reconnect
      </button>
      <button hidden data-perf-recover onClick={() => client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live" } }))}>
        Recover
      </button>
      <button
        hidden
        data-perf-reactions
        onClick={() =>
          client.updateSnapshot((current) => ({
            ...current,
            reactions: { active: Array.from({ length: 24 }, (_, index) => ({ eventId: `burst-${index}`, participantId: `perf-${index % (count - 1)}`, displayName: `Camera ${index + 1}`, reaction: "🎉", occurredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 4_000).toISOString() })) },
          }))
        }
      >
        Reaction burst
      </button>
      <button
        hidden
        data-perf-join
        onClick={() => {
          client.updateSnapshot(() => liveSnapshot({ others: Array.from({ length: count - 1 }, (_, index) => ({ id: `perf-${index}`, name: `Camera ${index + 1}` })) }));
          setGeneration((value) => value + 1);
          setJoined(true);
        }}
      >
        Join
      </button>
      <button hidden data-perf-people-in onClick={() => updateRoster(true)}>
        Add person
      </button>
      <button hidden data-perf-people-out onClick={() => updateRoster(false)}>
        Remove person
      </button>
      <button hidden data-perf-share-on onClick={() => updateRoster(false, true)}>
        Start share
      </button>
      <button hidden data-perf-share-off onClick={() => updateRoster(false)}>
        Stop share
      </button>
      <button hidden data-perf-board-on onClick={() => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, open: true, engine: { ...current.whiteboard.engine, status: "ready", sceneId: "scene-1", revision: "1", presenting: true } } }))}>
        Open board
      </button>
      <button hidden data-perf-board-off onClick={() => client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, open: false, engine: { ...current.whiteboard.engine, presenting: false } } }))}>
        Close board
      </button>
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
