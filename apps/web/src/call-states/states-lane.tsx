import { useEffect, useMemo, useState } from "react";
import { Chalk, CallLimbo, ToastStack, type ChalkProps } from "@q9labsai/chalk-react";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { PEOPLE, SPACE_NAME, createCallStateClient, liveSnapshot } from "./fixtures";
import type { CallState } from "./states";

type Terminal = ChalkProps["terminalState"] | "left" | "episode-ended" | "failed";
function StatesCall({ terminal, light = false, ready = false, reconnecting = false }: { readonly terminal?: Terminal; readonly light?: boolean; readonly ready?: boolean; readonly reconnecting?: boolean }) {
  const [reason, setReason] = useState(terminal);
  const client = useMemo(() => {
    const initial = liveSnapshot({ others: ready ? [] : PEOPLE.slice(0, 1) });
    return createCallStateClient({ ...initial, connection: { ...initial.connection, status: terminal === "left" || terminal === "failed" ? terminal : reconnecting ? "reconnecting" : "live" } });
  }, [ready, reconnecting, terminal]);
  useEffect(() => {
    if (terminal === "episode-ended") {
      client.emit("episodeEnded", { episode: null });
      void client.leave();
    }
  }, [client, terminal]);
  const terminalState = reason === "removed" || reason === "full" || reason === "elsewhere" ? reason : undefined;
  const rejoin = () => {
    setReason(undefined);
    client.updateSnapshot((current) => ({ ...current, connection: { ...current.connection, status: "live" } }));
  };
  return (
    <div className="relative h-dvh">
      <Chalk
        client={client}
        spaceName={SPACE_NAME}
        terminalState={terminalState}
        theme={{ colorScheme: light ? "light" : "dark" }}
        onRejoin={rejoin}
        onHome={() => {
          location.hash = "home";
        }}
        onLeft={() => undefined}
      />
      {!terminal && !reconnecting && !ready ? (
        <div className="absolute right-4 top-20 z-50 flex flex-col gap-2" aria-label="State event controls">
          <button
            onClick={() =>
              client.updateSnapshot((current) => {
                const person = liveSnapshot({ others: PEOPLE.slice(1, 2) }).participants.roster.find((p) => p.participantId !== current.self.participantId);
                return person ? { ...current, participants: { ...current.participants, roster: [...current.participants.roster, { ...person, participantId: `joined-${current.participants.roster.length}` }] } } : current;
              })
            }
          >
            Simulate join
          </button>
          <button onClick={() => client.updateSnapshot((current) => ({ ...current, participants: { ...current.participants, roster: current.participants.roster.map((p) => (p.participantId !== current.self.participantId ? { ...p, handRaised: true } : p)) } }))}>Simulate raised hand</button>
          <button onClick={() => void client.recording.start()}>Simulate recording</button>
          <button
            onClick={() => {
              client.updateSnapshot((current) => ({ ...current, media: { ...current.media, local: { ...current.media.local, camera: { ...current.media.local.camera, state: "failed" } } } }));
              client.emit("error", { error: new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Camera blocked" }) });
            }}
          >
            Simulate blocked camera
          </button>
          <button onClick={() => void client.leave()}>Leave fixture call</button>
        </div>
      ) : null}
    </div>
  );
}
function ToastFixture({ message, error = false, light = false }: { readonly message: string; readonly error?: boolean; readonly light?: boolean }) {
  const [visible, setVisible] = useState(true);
  return (
    <main data-chalk data-chalk-theme={light ? "light" : "dark"} className="chalk-root relative h-dvh bg-[var(--chalk-canvas)]">
      {visible ? <ToastStack toasts={[{ id: "fixture", message, type: error ? "error" : "info", duration: Infinity }]} onDismiss={() => setVisible(false)} /> : null}
    </main>
  );
}
export const STATES_LANE: readonly CallState[] = [
  { id: "states-events", title: "Call event journeys", render: () => <StatesCall /> },
  { id: "states-ready", title: "Ready card", render: () => <StatesCall ready /> },
  { id: "states-ready-light", title: "Ready card Light", render: () => <StatesCall ready light /> },
  { id: "states-joining", title: "Joining", render: () => <CallLimbo message={`Joining ${SPACE_NAME}…`} /> },
  { id: "states-joining-recorded", title: "Joining recorded call", render: () => <CallLimbo recorded message={`Joining ${SPACE_NAME}…`} /> },
  { id: "states-reconnecting", title: "Reconnecting", render: () => <StatesCall reconnecting /> },
  ...(
    [
      ["joined", "Nora joined", false],
      ["hand", "Nora raised a hand", false],
      ["recording", "Recording started. Everyone in the call can see it.", false],
      ["camera", "Chalk can’t use your camera. Click the camera icon in the address bar and allow Camera.", true],
      ["muted", "Nora muted you. Unmute when you’re ready.", false],
      ["share-blocked", "Your screen couldn’t be shared. Allow screen recording for your browser in System Settings, then try again.", true],
    ] as const
  ).flatMap(([id, message, error]) => [
    { id: `states-toast-${id}`, title: message, render: () => <ToastFixture message={message} error={error} /> },
    { id: `states-toast-${id}-light`, title: `${message} Light`, render: () => <ToastFixture message={message} error={error} light /> },
  ]),
  ...(["left", "episode-ended", "failed", "removed", "full", "elsewhere"] as const).flatMap((terminal) => [
    { id: `states-${terminal}`, title: terminal, render: () => <StatesCall terminal={terminal} /> },
    { id: `states-${terminal}-light`, title: `${terminal} Light`, render: () => <StatesCall terminal={terminal} light /> },
  ]),
];
