import { useState } from "react";
import { Chalk } from "@q9labsai/chalk-react";
import { createCallStateClient, liveSnapshot, PEOPLE, SPACE_NAME } from "./fixtures";

export function TimeLimitFixture({ role = "owner", ended = false, seconds = 600 }: { readonly role?: "owner" | "anonymous" | "guest"; readonly ended?: boolean; readonly seconds?: number }) {
  const [client] = useState(() => {
    const snapshot = liveSnapshot({ others: PEOPLE.slice(0, 2) });
    return createCallStateClient({
      ...snapshot,
      connection: {
        ...snapshot.connection,
        status: ended ? "left" : "live",
        episodeEnded: ended,
        episodeEndReason: ended ? "maximum_duration" : undefined,
        episode: { id: "time-limit", startedAt: new Date(Date.now() - 3000000).toISOString(), deadline: new Date(Date.now() + seconds * 1000).toISOString() },
      },
    });
  });
  const signup = () => location.assign("/dashboard/sign-in");
  return (
    <main className="h-dvh">
      <button
        hidden
        data-time-left
        onClick={(event) => {
          const next = Number(event.currentTarget.dataset.seconds);
          client.updateSnapshot((snapshot) => ({ ...snapshot, connection: { ...snapshot.connection, episode: snapshot.connection.episode && { ...snapshot.connection.episode, deadline: new Date(Date.now() + next * 1000).toISOString() } } }));
        }}
      >
        Set time left
      </button>
      <Chalk
        client={client}
        spaceName={SPACE_NAME}
        theme={{ colorScheme: "dark" }}
        onHome={() => location.assign("/")}
        timeLimit={{
          message: role === "owner" ? "Need more time?" : role === "anonymous" ? "Sign up free for calls up to 24 hours." : "The host can extend this call.",
          action:
            role === "owner"
              ? {
                  label: "Add 30 min",
                  onClick: () =>
                    client.updateSnapshot((snapshot) => ({ ...snapshot, connection: { ...snapshot.connection, episode: snapshot.connection.episode && { ...snapshot.connection.episode, deadline: new Date(Date.parse(snapshot.connection.episode.deadline ?? "") + 1800000).toISOString() } } })),
                }
              : role === "anonymous"
                ? { label: "Sign up free", onClick: signup }
                : undefined,
          endAction: role === "owner" ? { label: "Start a new call", onClick: () => location.assign("/dashboard") } : role === "anonymous" ? { label: "Sign up free", onClick: signup } : undefined,
        }}
      />
    </main>
  );
}
