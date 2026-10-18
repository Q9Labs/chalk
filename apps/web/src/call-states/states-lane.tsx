import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Chalk, CallLimbo, CallReady, ToastStack, type ChalkProps } from "@q9labsai/chalk-react";
import { SpaceClientError, type ClientFailure, type SpaceSnapshot } from "@q9labsai/chalk-client";
import { useCallLink } from "../../../../sdks/typescript/react/src/components/call-limbo/useCallLink";
import { Avatar } from "../../../../sdks/typescript/react/src/components/atomic/Avatar";
import { callEventToasts, mediaFailureToast } from "../../../../sdks/typescript/react/src/components/toast-stack/call-events";
import { ReconnectingOverlay } from "../../../../sdks/typescript/react/src/components/reconnecting-overlay/ReconnectingOverlay";
import { PEOPLE, SPACE_NAME, createCallStateClient, liveSnapshot } from "./fixtures";
import type { CallState } from "./states";

type Terminal = ChalkProps["terminalState"] | "left" | "episode-ended" | "failed";
function StatesCall({
  terminal,
  light = false,
  ready = false,
  reconnecting = false,
  reportProblem = false,
  endedJoin = false,
}: {
  readonly terminal?: Terminal;
  readonly light?: boolean;
  readonly ready?: boolean;
  readonly reconnecting?: boolean;
  readonly reportProblem?: boolean;
  readonly endedJoin?: boolean;
}) {
  const [reason, setReason] = useState(terminal);
  const client = useMemo(() => {
    const initial = liveSnapshot({ others: ready ? [] : PEOPLE.slice(0, 1) });
    return createCallStateClient({
      ...initial,
      connection: { ...initial.connection, lastError: endedJoin ? { code: "episode.ended", recoverable: false, message: "The Episode has ended" } : initial.connection.lastError, status: terminal === "left" || terminal === "failed" ? terminal : reconnecting ? "reconnecting" : "live" },
    });
  }, [endedJoin, ready, reconnecting, terminal]);
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
        onReportProblem={
          reportProblem
            ? () => {
                location.hash = "report";
              }
            : undefined
        }
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
              client.emit("error", { error: new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Camera blocked" }) });
              client.updateSnapshot((current) => ({ ...current, media: { ...current.media, local: { ...current.media.local, camera: { ...current.media.local.camera, state: "failed" } } } }));
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
function toastForFixture(id: string) {
  if (id === "camera" || id === "share-blocked") return mediaFailureToast({ code: "media.permission_denied", message: "Blocked", recoverable: true }, id === "camera" ? "camera" : "screen") ?? { message: "" };
  if (id === "muted")
    return {
      message: (
        <>
          <b style={{ fontWeight: 600 }}>Nora</b> muted you. Unmute when you’re ready.
        </>
      ),
      icon: <Avatar name="Nora" size="xs" style={{ width: 28, height: 28 }} animated={false} />,
    };
  const previous = liveSnapshot({ others: id === "joined" ? [] : PEOPLE.slice(0, 1) });
  if (id === "host") {
    const before = { ...previous, participants: { ...previous.participants, roster: previous.participants.roster.map((p) => (p.participantId === previous.self.participantId ? p : { ...p, role: "host", displayName: "Nora" })) } };
    const next = { ...previous, self: { ...previous.self, role: "host" }, participants: { ...previous.participants, roster: previous.participants.roster.filter((p) => p.participantId === previous.self.participantId) } };
    const toast = callEventToasts(before, next)[0];
    if (!toast) throw new Error("No host transfer event");
    return toast;
  }
  if (id === "device") {
    const old = { deviceId: "airpods", label: "AirPods Pro" };
    const selected = { deviceId: "built-in", label: "MacBook Air Microphone" };
    const before = { ...previous, media: { ...previous.media, selection: { ...previous.media.selection, microphone: old.deviceId }, devices: { ...previous.media.devices, microphones: [old, selected] } } };
    const next = { ...before, media: { ...before.media, selection: { ...before.media.selection, microphone: selected.deviceId }, devices: { ...before.media.devices, microphones: [selected] } } };
    const toast = callEventToasts(before, next)[0];
    if (!toast) throw new Error("No device disconnect event");
    return toast;
  }
  const populated = liveSnapshot({ others: PEOPLE.slice(0, 1) });
  const next: SpaceSnapshot =
    id === "hand"
      ? { ...previous, participants: { ...previous.participants, roster: previous.participants.roster.map((p) => (p.participantId === previous.self.participantId ? p : { ...p, handRaised: true })) } }
      : id === "recording"
        ? { ...previous, recording: { ...previous.recording, current: { recordingId: "fixture", status: "recording" satisfies "recording", failureCode: null } } }
        : populated;
  const toast = callEventToasts(previous, next)[0];
  if (!toast) throw new Error(`No production event for ${id}`);
  return toast;
}
function ToastFixture({ message, icon, action, error = false, light = false }: { readonly message: ReactNode; readonly icon?: ReactNode; readonly action?: { readonly label: string; readonly onClick: () => void }; readonly error?: boolean; readonly light?: boolean }) {
  const [visible, setVisible] = useState(true);
  return (
    <main data-chalk data-chalk-theme={light ? "light" : "dark"} className="chalk-root relative h-dvh bg-[var(--chalk-canvas)]" style={{ fontSize: 14, lineHeight: 1.4 }}>
      {visible ? (
        <ToastStack
          toasts={[
            {
              id: "fixture",
              message:
                error && typeof message === "string" && message.includes(". ") ? (
                  <>
                    <b style={{ fontWeight: 600 }}>{message.slice(0, message.indexOf(". ") + 1)}</b> {message.slice(message.indexOf(". ") + 2)}
                  </>
                ) : (
                  message
                ),
              icon,
              type: error ? "error" : "info",
              duration: Infinity,
              action,
            },
          ]}
          onDismiss={() => setVisible(false)}
        />
      ) : null}
    </main>
  );
}
function CallLinkFixture() {
  const [alone, setAlone] = useState(true);
  const callLink = useCallLink(alone);
  return (
    <main data-chalk data-chalk-theme="dark" className="chalk-root relative h-dvh bg-[var(--chalk-canvas)]" style={{ fontSize: 14, lineHeight: 1.4 }}>
      <button data-call-link-trigger aria-pressed={callLink.open} onClick={callLink.toggle}>
        {callLink.open ? "Hide call link" : "Show call link"}
      </button>
      <button onClick={() => setAlone(false)}>Someone joins</button>
      <button onClick={() => setAlone(true)}>Everyone leaves</button>
      <CallReady open={callLink.open} onClose={callLink.close} link="https://chalk.example/join/example" />
    </main>
  );
}
function ReconnectingInputFixture() {
  return (
    <main data-chalk data-chalk-theme="dark" className="chalk-root relative h-dvh bg-[var(--chalk-canvas)]">
      <label>
        Message
        <textarea aria-label="Message" />
      </label>
      <ReconnectingOverlay isVisible status="reconnecting" />
    </main>
  );
}
function CommandFailureFixture() {
  const [failure, setFailure] = useState<ClientFailure | null>(null);
  const [source, setSource] = useState<"microphone" | "camera" | "screen">("camera");
  const toast = mediaFailureToast(failure, source);
  return (
    <main data-chalk data-chalk-theme="dark" className="chalk-root relative h-dvh bg-[var(--chalk-canvas)]" style={{ fontSize: 14, lineHeight: 1.4 }}>
      {(["camera", "microphone", "screen"] as const).map((value) => (
        <button key={value} onClick={() => setSource(value)}>
          {value}
        </button>
      ))}
      {(["media.permission_denied", "media.device_not_found", "media.device_busy", "media.device_constraint_invalid", "media.capture_failed", "client.internal_error"] as const).map((code) => (
        <button key={code} onClick={() => setFailure({ code, message: "The command could not be completed.", recoverable: true })}>
          {code}
        </button>
      ))}
      <ToastStack toasts={toast ? [{ id: `${source}-${failure?.code}`, ...toast }] : []} onDismiss={() => setFailure(null)} />
    </main>
  );
}
export const STATES_LANE: readonly CallState[] = [
  { id: "states-reconnecting-input", title: "Reconnecting keeps input usable", render: () => <ReconnectingInputFixture /> },
  { id: "states-link-controls", title: "Controlled call link", render: () => <CallLinkFixture /> },
  { id: "states-command-failures", title: "Typed command failures", render: () => <CommandFailureFixture /> },
  { id: "states-ended-join", title: "Already-ended join", render: () => <StatesCall terminal="failed" endedJoin /> },
  { id: "states-events", title: "Call event journeys", render: () => <StatesCall /> },
  { id: "states-ready", title: "Ready card", render: () => <StatesCall ready /> },
  { id: "states-ready-light", title: "Ready card Light", render: () => <StatesCall ready light /> },
  {
    id: "states-joining",
    title: "Joining",
    render: () => (
      <div className="h-dvh">
        <CallLimbo message={`Joining ${SPACE_NAME}…`} />
      </div>
    ),
  },
  {
    id: "states-joining-light",
    title: "Joining Light",
    render: () => (
      <div className="h-dvh">
        <CallLimbo theme={{ colorScheme: "light" }} message={`Joining ${SPACE_NAME}…`} />
      </div>
    ),
  },
  {
    id: "states-joining-recorded",
    title: "Joining recorded call",
    render: () => (
      <div className="h-dvh">
        <CallLimbo recorded message={`Joining ${SPACE_NAME}…`} />
      </div>
    ),
  },
  { id: "states-reconnecting", title: "Reconnecting", render: () => <StatesCall reconnecting /> },
  { id: "states-reconnecting-light", title: "Reconnecting Light", render: () => <StatesCall reconnecting light /> },
  ...(
    [
      ["joined", "Nora joined", false],
      ["hand", "Nora raised a hand", false],
      ["recording", "Recording started. Everyone in the call can see it.", false],
      ["camera", "Chalk can’t use your camera. Click the camera icon in the address bar and allow Camera.", true],
      ["host", "Nora left. You’re now the host.", false],
      ["device", "AirPods Pro disconnected. Switched to MacBook Air Microphone", false],
      ["muted", "Nora muted you. Unmute when you’re ready.", false],
      ["share-blocked", "Your screen couldn’t be shared. Allow screen recording for your browser in System Settings, then try again.", true],
    ] as const
  ).flatMap(([id, message, error]) => {
    const renderToast = (light: boolean) => {
      const toast = toastForFixture(id);
      return <ToastFixture light={light} message={toast.message} icon={toast.icon} action={id === "share-blocked" ? { label: "Try again", onClick: () => undefined } : undefined} error={error} />;
    };
    return [
      { id: `states-toast-${id}`, title: message, render: () => renderToast(false) },
      { id: `states-toast-${id}-light`, title: `${message} Light`, render: () => renderToast(true) },
    ];
  }),
  ...(["left", "episode-ended", "failed", "removed", "full", "elsewhere"] as const).flatMap((terminal) => [
    { id: `states-${terminal}`, title: terminal, render: () => <StatesCall terminal={terminal} /> },
    { id: `states-${terminal}-light`, title: `${terminal} Light`, render: () => <StatesCall terminal={terminal} light /> },
    { id: `states-${terminal}-report`, title: `${terminal} with report action`, render: () => <StatesCall terminal={terminal} reportProblem /> },
    { id: `states-${terminal}-light-report`, title: `${terminal} Light with report action`, render: () => <StatesCall terminal={terminal} light reportProblem /> },
  ]),
];
