import { useEffect, useState } from "react";
import type { ScreenAnnotationClient, ScreenAnnotationCommand, ScreenAnnotationDraft, ScreenAnnotationMark, ScreenAnnotationPresence, ScreenAnnotationSnapshot, ScreenAnnotationState, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import type { ScreenAnnotationActions } from "@q9labsai/chalk-react";
import { ScreenShareViewSurface } from "@q9labsai/chalk-react";
import { ShellStyles } from "@q9labsai/chalk-react/utils";
import { webAnnotation } from "../lib/screen-annotation";

// token-ratchet-ignore: fixture ink is a wire-format color, not a UI theme color.
const viewer = { participant_id: "2dca7fd4-6ab1-4bf2-8f0a-df06ec2d5f61", display_name: "Omar", color: "#ff734e" };
// token-ratchet-ignore: fixture ink is a wire-format color, not a UI theme color.
const sharer = { participant_id: "2b058c78-1651-43b6-8b13-647aeb6b35be", display_name: "Sara", color: "#786bff" };
const layer = { layer_id: "04acfe87-75d3-4374-90e9-61cab633fbfd", publication_id: "screen-fixture", sharer_id: sharer.participant_id, frame: { width: 1600, height: 900 } };
const ready = (state: ScreenAnnotationState, presence: readonly ScreenAnnotationPresence[]): ScreenAnnotationSnapshot => ({ status: "ready", state, presence });

function createAnnotationFixture() {
  const listeners = new Set<() => void>();
  const undo: ScreenAnnotationMark[] = [];
  const access = { can_draw: true, draw_policy: "everyone", can_manage_policy: false, can_moderate: false, default_color: viewer.color, requests: [] } satisfies Omit<ScreenAnnotationState["access"], "draw_policy" | "requests"> & { draw_policy: "everyone"; requests: [] };
  let state: ScreenAnnotationState = { layer, fence: 1, revision: 1, marks: [], paused: false, access };
  let presence: readonly ScreenAnnotationPresence[] = [];
  let viewerSnapshot = ready(state, presence);
  let hostSnapshot = ready(state, presence);
  let active = true;
  const notify = () => {
    const host = { ...state, access: { ...state.access, default_color: sharer.color, can_draw: true, can_manage_policy: true, can_moderate: true } };
    viewerSnapshot = active ? ready(state, presence) : { status: "connecting" };
    hostSnapshot = active ? ready(host, presence) : { status: "connecting" };
    listeners.forEach((listener) => listener());
  };
  const fence = () => {
    state = { ...state, fence: state.fence + 1 };
    presence = [];
  };
  type AccessCommand = Extract<ScreenAnnotationCommand, { kind: "request_draw" | "decide_draw" | "set_policy" | "set_draw_permission" | "pause" }>;
  const changeAccess = (command: AccessCommand, author: typeof viewer, host: boolean, now: number): boolean => {
    if (!host && command.kind !== "request_draw") return false;
    switch (command.kind) {
      case "request_draw":
        if (state.access.draw_policy === "hosts") return false;
        state = { ...state, access: { ...state.access, requests: [{ request_id: crypto.randomUUID(), participant_id: author.participant_id, expires_at_ms: now + 30000 }] } };
        break;
      case "decide_draw":
        state = { ...state, access: { ...state.access, can_draw: command.allow, requests: [] } };
        fence();
        break;
      case "set_policy":
        state = { ...state, access: { ...state.access, draw_policy: command.policy, can_draw: command.policy === "everyone", requests: [] } };
        fence();
        break;
      case "set_draw_permission":
        state = { ...state, access: { ...state.access, can_draw: command.allow } };
        fence();
        break;
      case "pause":
        state = { ...state, paused: command.paused };
        fence();
        break;
    }
    return true;
  };
  const controller = (author: typeof viewer, host: boolean): ScreenAnnotationClient => ({
    getSnapshot: () => (host ? hostSnapshot : viewerSnapshot),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    serverNowMs: Date.now,
    setPresence(target, cursor, draft) {
      if (!active || target.fence !== state.fence || (!host && (!state.access.can_draw || state.paused))) return;
      const other = presence.filter((sample) => sample.author.participant_id !== author.participant_id);
      presence = cursor || draft ? [...other, { type: "annotation_presence", layer_id: target.layerId, fence: target.fence, cursor, draft, author, expires_at_ms: Date.now() + 1000, server_at_ms: Date.now() }] : other;
      notify();
    },
    async dispatch(target: ScreenAnnotationTarget, command: ScreenAnnotationCommand) {
      if (!active || target.layerId !== state.layer.layer_id || target.fence !== state.fence) return { kind: "rejected", reason: "stale_fence" };
      if (!host && (!state.access.can_draw || state.paused) && command.kind !== "request_draw" && command.kind !== "clear") return { kind: "rejected", reason: "forbidden" };
      const revision = state.revision + 1;
      const now = Date.now();
      switch (command.kind) {
        case "commit":
          undo.length = 0;
          state = { ...state, marks: [...state.marks, { draft: command.draft, author, created_revision: revision, committed_at_ms: now, expires_at_ms: command.draft.lifetime === "fade" ? now + 2000 : null }] };
          break;
        case "undo": {
          const last = state.marks.filter((mark) => mark.author.participant_id === author.participant_id && mark.draft.lifetime === "keep").at(-1);
          if (last) {
            undo.push(last);
            state = { ...state, marks: state.marks.filter((mark) => mark !== last) };
          }
          break;
        }
        case "redo": {
          const last = undo.pop();
          if (last) state = { ...state, marks: [...state.marks, last] };
          break;
        }
        case "erase":
          state = { ...state, marks: state.marks.filter((mark) => mark.draft.mark_id !== command.mark_id) };
          break;
        case "clear":
          state = { ...state, marks: state.marks.filter((mark) => command.scope.kind !== "all" && mark.author.participant_id !== (command.scope.kind === "mine" ? author.participant_id : command.scope.participant_id)) };
          undo.length = 0;
          fence();
          break;
        default:
          if (!changeAccess(command, author, host, now)) return { kind: "rejected", reason: "forbidden" };
      }
      state = { ...state, revision };
      notify();
      return { kind: "accepted", layer_id: layer.layer_id, revision };
    },
  });
  const viewerClient = controller(viewer, false);
  const hostClient = controller(sharer, true);
  notify();
  return {
    viewerClient,
    hostClient,
    end: () => {
      active = false;
      presence = [];
      notify();
    },
    setPolicy: (policy: "hosts" | "picked" | "everyone") => hostClient.dispatch({ layerId: layer.layer_id, fence: state.fence }, { kind: "set_policy", policy }),
    commit: (client: ScreenAnnotationClient, draft: ScreenAnnotationDraft) => client.dispatch({ layerId: layer.layer_id, fence: state.fence }, { kind: "commit", draft }),
    ask: () => viewerClient.dispatch({ layerId: layer.layer_id, fence: state.fence }, { kind: "request_draw" }),
  };
}

function useFixtureTrack() {
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  useEffect(() => {
    const frame = document.createElement("canvas");
    frame.width = layer.frame.width;
    frame.height = layer.frame.height;
    const ctx = frame.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#edf0f5";
    ctx.fillRect(0, 0, frame.width, frame.height);
    ctx.fillStyle = "#253245";
    ctx.font = "700 56px system-ui";
    ctx.fillText("Design review", 70, 110);
    ctx.font = "36px system-ui";
    for (const [index, label] of ["Screen annotation", "Frame-fixed geometry", "Private preview"].entries()) {
      ctx.fillStyle = "#d7dfe9";
      ctx.fillRect(70, 210 + index * 115, 720, 84);
      ctx.fillStyle = "#253245";
      ctx.fillText(label, 96, 262 + index * 115);
    }
    ctx.fillStyle = "#4876bd";
    ctx.fillRect(1190, 320, 270, 240);
    const video = frame.captureStream(8).getVideoTracks()[0];
    if (!video) return;
    const timer = window.setInterval(() => ctx.fillRect(1190, 320, 1, 1), 125);
    setTrack(video);
    return () => {
      clearInterval(timer);
      video.stop();
    };
  }, []);
  return track;
}

type HelperFixture = "offer" | "fingerprint" | "confirm" | "connected";

const fingerprint = "4F2A-91C0";
const approval = (attach: (status: (value: "ready") => void, ask: (signal: AbortSignal) => Promise<string>) => Promise<void>) => async () => ({ kind: "approval" as const, fingerprint, remembered: false, attach });

const helperFixtures = {
  offer: { challenge: async () => Promise.reject(new DOMException("Local access denied", "NotAllowedError")) },
  fingerprint: { challenge: approval(() => new Promise<void>(() => {})) },
  confirm: { challenge: approval((_status, ask) => ask(new AbortController().signal).then(() => new Promise<void>(() => {}))) },
  connected: { challenge: approval(async (status) => status("ready")) },
} as const;

const at = (x: number, y: number) => ({ x: Math.round(x * 65535), y: Math.round(y * 65535) });
const stroke = (id: string, color: string, shape: ScreenAnnotationDraft["shape"]): ScreenAnnotationDraft => ({ mark_id: id, lifetime: "keep", color, width: 192, shape });

export interface ScreenAnnotationScene {
  readonly view?: "viewer" | "host";
  readonly policy?: "everyone" | "picked" | "hosts";
  /** The viewer has asked to draw, which only means something under Ask first. */
  readonly asked?: boolean;
  /** Both people have already drawn on the share. */
  readonly marks?: boolean;
  readonly captureSurface?: "browser" | "monitor";
  readonly helper?: HelperFixture;
}

export function ScreenAnnotationFixture({ view = "viewer", policy = "everyone", asked = false, marks = false, captureSurface = "browser", helper }: ScreenAnnotationScene = {}) {
  const [fixture] = useState(() => {
    const made = createAnnotationFixture();
    void (async () => {
      if (marks) {
        await made.commit(made.viewerClient, stroke("omar-pen", "#c15a10", { kind: "pen", points: [at(0.3, 0.55), at(0.4, 0.6), at(0.55, 0.6), at(0.7, 0.55)] }));
        await made.commit(made.viewerClient, stroke("omar-arrow", "#c15a10", { kind: "arrow", from_point: at(0.55, 0.3), to_point: at(0.8, 0.45) }));
        await made.commit(made.hostClient, stroke("sara-box", "#786bff", { kind: "box", from_point: at(0.08, 0.32), to_point: at(0.45, 0.45) }));
      }
      if (policy !== "everyone") await made.setPolicy(policy);
      if (asked) await made.ask();
    })();
    return made;
  });
  const [saved, setSaved] = useState(0);
  const [hostView, setHostView] = useState(view === "host" || helper !== undefined);
  const track = useFixtureTrack();
  const actions: ScreenAnnotationActions = { saveToWhiteboard: async (frame) => setSaved(frame.marks.length) };
  const people = [viewer, sharer].map((person) => ({ id: person.participant_id, name: person.display_name, roleCanDraw: true, managesPolicy: person === sharer }));
  const actor = hostView ? sharer : viewer;
  return (
    <main data-chalk="" className="chalk-frame grid min-h-screen place-content-center gap-3 p-4">
      <ShellStyles />
      <div className="flex flex-wrap gap-3" aria-label="Fixture controls">
        <button type="button" onClick={() => setHostView(!hostView)}>
          {hostView ? "View as Omar" : "View as Sara"}
        </button>
        <button type="button" onClick={() => void fixture.setPolicy("picked")}>
          Require approval
        </button>
        <button type="button" onClick={() => void fixture.setPolicy("hosts")}>
          Restrict to hosts
        </button>
        <button type="button" onClick={fixture.end}>
          End share
        </button>
        {saved ? <p role="status">{saved} accepted marks sent to board</p> : null}
      </div>
      <div className="relative h-[min(74vh,700px)] w-[min(94vw,1100px)]">
        {track ? (
          <ScreenShareViewSurface
            key={actor.participant_id}
            screenShareTrack={track}
            sharedByName="Sara"
            isLocal={hostView}
            onStopSharing={hostView ? async () => fixture.end() : undefined}
            onChangeShare={hostView ? async () => undefined : undefined}
            capture={hostView ? { surface: helper ? "monitor" : captureSurface, label: null } : undefined}
            annotationContext={{ actorId: actor.participant_id, actorName: actor.display_name, people, grants: [] }}
            annotation={{
              client: hostView ? fixture.hostClient : fixture.viewerClient,
              publicationId: layer.publication_id,
              actions,
              fontUrl: webAnnotation.fontUrl,
              offerPngDownload: webAnnotation.offerPngDownload,
              helper: {
                installUrl: helper ? "https://downloads.chalkmeet.com/helper/" : undefined,
                challenge: helper
                  ? helperFixtures[helper].challenge
                  : async () => {
                      throw new DOMException("Local access denied", "NotAllowedError");
                    },
                lookupCode: async () => ({ deviceName: "Demo Mac", approve: async (status) => status("ready") }),
              },
            }}
          />
        ) : null}
      </div>
    </main>
  );
}
