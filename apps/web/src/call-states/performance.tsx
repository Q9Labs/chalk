import { Chalk } from "@q9labsai/chalk-react";
import { useState } from "react";
import { createCallStateClient, liveSnapshot, PEOPLE, SELF_NAME, SPACE_NAME } from "./fixtures";
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
      <Chalk theme={{ colorScheme: "dark" }} client={client} entrance={false} displayName={SELF_NAME} spaceName={SPACE_NAME} layout={count === 24 ? "grid" : "focus"} onLeft={() => undefined} />
    </main>
  );
}
