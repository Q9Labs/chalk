import type { ScreenAnnotationCommand, ScreenAnnotationDraft, ScreenAnnotationPoint, ScreenAnnotationPresence, ScreenAnnotationState, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import { BakedExportProof, INK_PROOF_TIMEOUT_MS } from "@q9labsai/chalk-screen-annotation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { PresentedAnnotationFrame } from "../components/rtc-video-view-availability";
import type { Frame } from "../motion/MovingFrame";
import { AnnotationNote } from "./AnnotationNote";
import { layerPresenceFor, type CommittingMark } from "./layer-presence";
import { AnnotationCanvas, type AnnotationCanvasHandle } from "./AnnotationCanvas";
import { ScreenAnnotationToolbar, ToolButton, type ScreenAnnotationToolbarProps } from "./ScreenAnnotationToolbar";
import { canCapture, hasTarget, initialViewport, matchLayer, targetFor, visibleCommittedMarks, visibleFrame, type Ink, type ScreenAnnotationOptions, type ScreenAnnotationSource } from "./model";
import { nativeAnnotationExport } from "./native-annotation-export";
import type { NativeAnnotationBoard } from "./save-to-board";
import { useAnnotationInput, type TextAnchor } from "./use-annotation-input";

export type ScreenAnnotationLayerProps = ScreenAnnotationOptions & {
  readonly person: { readonly id: string; readonly name: string };
  readonly people?: ScreenAnnotationToolbarProps["people"];
  readonly canSave?: boolean;
  readonly boardSave?: NativeAnnotationBoard;
  readonly source: ScreenAnnotationSource | null;
  readonly viewport: Frame;
  /** Render the video in exactly this native view rectangle, without another transform. */
  readonly video: (frame: Frame, onPresented?: (frame: PresentedAnnotationFrame) => void, burnedIn?: boolean) => ReactNode;
  readonly controls?: (tray: ReactNode) => ReactNode;
  readonly reportError?: (message: string) => void;
};

export function ScreenAnnotationLayer(props: ScreenAnnotationLayerProps): React.JSX.Element {
  const { client, publicationId, source, viewport, video } = props;
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (snapshot.status !== "ready" || !snapshot.state || snapshot.state.layer.publication_id !== publicationId || !source?.rendererUrl?.startsWith("file:///") || !hasSize(source.size) || !hasSize(viewport)) {
    return <>{video(viewport)}</>;
  }
  return <MatchedLayer key={snapshot.state.layer.layer_id} {...props} rendererUrl={source.rendererUrl} source={source} presence={snapshot.presence} state={snapshot.state} />;
}

type MatchedProps = ScreenAnnotationLayerProps & {
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly rendererUrl: string;
  readonly source: ScreenAnnotationSource;
  readonly state: ScreenAnnotationState;
};

function MatchedLayer({ actions, boardSave, canSave, client, controls, people, person, presence, publicationId, rendererUrl, reportError, source, state, video, viewport }: MatchedProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [style, setStyle] = useState<Omit<Ink, "color"> & { readonly color: string | null }>({ tool: "pen", lifetime: "fade", width: 193, stamp: "check", color: null });
  const [pan, setPan] = useState(initialViewport);
  const [textAnchor, setTextAnchor] = useState<TextAnchor | null>(null);
  const [committing, setCommitting] = useState<CommittingMark | null>(null);
  const erase = useRef<{ readonly id: number; readonly target: ScreenAnnotationTarget } | null>(null);
  const eraseCounter = useRef(0);
  const canvas = useRef<AnnotationCanvasHandle>(null);
  const exporting = useRef(false);
  const [finishingInk, setFinishingInk] = useState(false);
  const [waitingForInk, setWaitingForInk] = useState(false);
  const pendingHandoffs = useRef(new Set<string>());
  const finishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exportProof = useMemo(() => new BakedExportProof(), [state.fence]);
  const onBakedInk = useCallback(
    (id: string, handedOff: boolean) => {
      exportProof.finish(id);
      if (handedOff && pendingHandoffs.current.delete(id) && pendingHandoffs.current.size === 0) {
        clearTimeout(finishTimer.current);
        setFinishingInk(false);
      }
    },
    [exportProof],
  );
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Cancel the post-gesture observation window on layer teardown.
  useEffect(() => () => clearTimeout(finishTimer.current), []);
  const onPresented = useCallback((frame: PresentedAnnotationFrame) => canvas.current?.presented(frame), []);

  const ink: Ink = { ...style, color: style.color ?? state.access.default_color };
  const rect = visibleFrame(source.size, viewport, pan);
  const allowed = ready && canCapture(state, person.id);
  const nowMs = client.serverNowMs();
  const target = targetFor(state);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Wake saves when their unproved ink has been removed from the authoritative scene.
  useEffect(() => {
    if (!state.layer.burned_in || !ready) return;
    const at = client.serverNowMs();
    const marks = visibleCommittedMarks(state, at);
    exportProof.reconcile(state.revision, new Set(marks.map(({ draft }) => draft.mark_id)));
    for (const mark of marks) {
      if (!exportProof.observe(mark.draft.mark_id, mark.created_revision)) continue;
      canvas.current?.watchInk(
        {
          type: "annotation_presence",
          layer_id: state.layer.layer_id,
          fence: state.fence,
          author: mark.author,
          server_at_ms: at,
          expires_at_ms: mark.expires_at_ms ?? at + INK_PROOF_TIMEOUT_MS,
          cursor: null,
          draft: mark.draft,
        },
        mark.created_revision,
      );
    }
  }, [client, exportProof, ready, state]);

  async function dispatch(frozen: ScreenAnnotationTarget, command: ScreenAnnotationCommand) {
    if (!hasTarget(matchLayer(client, publicationId), frozen)) return null;
    try {
      const result = await client.dispatch(frozen, command);
      // A stale fence usually means the corresponding clear, pause, or permission change just arrived.
      if (result.kind !== "accepted" && !(result.kind === "rejected" && result.reason === "stale_fence")) {
        reportError?.(result.kind === "rejected" ? "That mark action is no longer available." : "Couldn’t confirm the mark action.");
      }
      return result;
    } catch {
      reportError?.("Couldn’t confirm the mark action.");
      return null;
    }
  }

  function commit(draft: ScreenAnnotationDraft, frozen: ScreenAnnotationTarget) {
    const live = matchLayer(client, publicationId);
    if (!hasTarget(live, frozen) || !canCapture(live, person.id)) return;
    if (live.layer.burned_in) {
      const now = client.serverNowMs();
      const id = draft.mark_id;
      exportProof.expect(id);
      canvas.current?.holdInk({
        type: "annotation_presence",
        layer_id: frozen.layerId,
        fence: frozen.fence,
        author: { participant_id: person.id, display_name: person.name, color: live.access.default_color },
        server_at_ms: now,
        expires_at_ms: now + INK_PROOF_TIMEOUT_MS,
        cursor: null,
        draft,
      });
      pendingHandoffs.current.add(id);
      setFinishingInk(true);
      clearTimeout(finishTimer.current);
      finishTimer.current = setTimeout(() => {
        pendingHandoffs.current.clear();
        setFinishingInk(false);
      }, INK_PROOF_TIMEOUT_MS);
      void dispatch(frozen, { kind: "commit", draft }).then((result) => {
        if (result?.kind === "accepted") {
          exportProof.accepted(id, result.revision);
          canvas.current?.settleInk(id, result.revision);
        } else if (result?.kind !== "delivery_unknown") {
          exportProof.settle(id);
          canvas.current?.settleInk(id, null);
        }
      });
      return;
    }
    setCommitting({ draft, target: frozen });
    void dispatch(frozen, { kind: "commit", draft }).then((result) => {
      setCommitting((current) => (current?.draft.mark_id !== draft.mark_id ? current : result?.kind === "accepted" ? { ...current, untilRevision: result.revision } : null));
    });
  }

  function onHit(request: number, markId: string | null) {
    const action = erase.current;
    if (!action || action.id !== request) return;
    erase.current = null;
    const live = matchLayer(client, publicationId);
    if (!markId || !hasTarget(live, action.target) || !canCapture(live, person.id)) return;
    const mark = live.marks.find(({ draft }) => draft.mark_id === markId);
    if (mark && (mark.author.participant_id === person.id || live.access.can_moderate)) {
      void dispatch(action.target, { kind: "erase", mark_id: markId });
    }
  }

  const input = useAnnotationInput({
    client,
    publicationId,
    participantId: person.id,
    displayName: person.name,
    color: state.access.default_color,
    ink,
    rect,
    viewport: pan,
    onViewport: setPan,
    onText: setTextAnchor,
    onErase: (point: ScreenAnnotationPoint, frozen) => {
      const id = ++eraseCounter.current;
      erase.current = { id, target: frozen };
      canvas.current?.hit(id, point, state.access.can_moderate ? null : person.id);
    },
    onCommit: commit,
  });

  const sampling = Boolean(state.layer.burned_in && ready && (input.local?.draft || finishingInk || waitingForInk));

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Observe decoded pixels for exports only on iOS; Android uses the displayed track.
  useEffect(() => {
    const sample = source.sampleFrame;
    if (!sampling || !sample) return;
    let stopped = false;
    let next: ReturnType<typeof setTimeout>;
    async function readSample() {
      if (stopped || !sample) return;
      const png = await sample().catch(() => null);
      if (stopped) return;
      if (png) canvas.current?.sampled(png);
      next = setTimeout(() => void readSample(), 200);
    }
    void readSample();
    return () => {
      stopped = true;
      clearTimeout(next);
    };
  }, [sampling, source]);

  const { layerPresence, localTouch } = layerPresenceFor({ presence, localSample: input.local, committing, target, allowed, open, state, person, nowMs });
  const { save, download, exportFrame } = nativeAnnotationExport({ client, publicationId, source, target, canSave, actions, boardSave, reportError, canvas, exporting, exportProof, setWaitingForInk });
  const scene = useMemo(
    () => ({
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clip: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
      marks: state.marks,
      revision: state.revision,
      burnedIn: state.layer.burned_in,
      paused: state.paused,
      sharerId: state.layer.sharer_id,
    }),
    [rect.x, rect.y, rect.width, rect.height, viewport.x, viewport.y, viewport.width, viewport.height, state.marks, state.revision, state.layer.burned_in, state.paused, state.layer.sharer_id],
  );
  const tray = ready ? (
    open ? (
      <ScreenAnnotationToolbar
        state={state}
        participantId={person.id}
        people={people}
        ink={ink}
        drawingAllowed={allowed}
        canRequestDraw={!state.access.can_draw && state.access.draw_policy !== "hosts"}
        serverNowMs={() => client.serverNowMs()}
        onInk={setStyle}
        onCommand={(command) => void dispatch(target, command)}
        onClose={() => {
          input.cancel();
          setOpen(false);
          setTextAnchor(null);
        }}
        onSave={save ? () => void exportFrame(save) : undefined}
        onDownload={download ? () => void exportFrame(download) : undefined}
      />
    ) : (
      <ToolButton label="Annotate screen" icon="pen" onPress={() => setOpen(true)} />
    )
  ) : null;
  const setCanvasReady = (value: boolean) => {
    if (!value) input.cancel();
    setReady(value);
  };

  return (
    <>
      {video(rect, sampling ? onPresented : undefined, state.layer.burned_in)}
      <AnnotationCanvas
        ref={canvas}
        rendererUrl={rendererUrl}
        onReady={setCanvasReady}
        onFailure={(reason) => reportError?.(reason === "load" ? "Screen annotations are unavailable because the renderer could not load." : "Screen annotations are unavailable because the renderer stopped.")}
        onHit={onHit}
        onBakedInk={onBakedInk}
        scene={scene}
        nowMs={nowMs}
        localTouch={localTouch}
        presence={layerPresence}
      />
      {open && allowed ? <View accessible={false} style={StyleSheet.absoluteFill} testID="annotation.surface" onStartShouldSetResponder={() => true} onResponderStart={input.onStart} onResponderMove={input.onMove} onResponderEnd={input.onEnd} onResponderTerminate={input.cancel} /> : null}
      {controls ? (
        controls(tray)
      ) : (
        <View pointerEvents="box-none" style={styles.defaultTray}>
          {tray}
        </View>
      )}
      {textAnchor && hasTarget(state, textAnchor.target) && allowed ? (
        <AnnotationNote
          onClose={() => setTextAnchor(null)}
          onSave={(text, note) => {
            const { at, draft, target: frozen } = textAnchor;
            setTextAnchor(null);
            commit({ ...draft, shape: { kind: "text", at, text, note } }, frozen);
          }}
        />
      ) : null}
    </>
  );
}

function hasSize(size: { readonly width: number; readonly height: number }): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

const styles = StyleSheet.create({
  defaultTray: { position: "absolute", bottom: 0, left: 8, right: 8, alignItems: "center" },
});
