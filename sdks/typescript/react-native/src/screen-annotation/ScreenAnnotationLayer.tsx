import { corners, space } from "../theme/tokens";
import type { ScreenAnnotationCommand, ScreenAnnotationDraft, ScreenAnnotationPoint, ScreenAnnotationPresence, ScreenAnnotationState, ScreenAnnotationTarget } from "@q9labsai/chalk-client";
import { LASER_TRAIL_MS, NATIVE_INK_PROOF_TIMEOUT_MS } from "@q9labsai/chalk-screen-annotation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Modal, StyleSheet, TextInput, View } from "react-native";
import type { PresentedAnnotationFrame } from "../components/rtc-video-view-availability";
import type { Frame } from "../motion/MovingFrame";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import { AnnotationCanvas, type AnnotationCanvasHandle } from "./AnnotationCanvas";
import { ScreenAnnotationToolbar, ToolButton, type ScreenAnnotationToolbarProps } from "./ScreenAnnotationToolbar";
import { boundedNote, canCapture, hasTarget, initialViewport, matchLayer, targetFor, visibleFrame, type Ink, type ScreenAnnotationOptions, type ScreenAnnotationSource } from "./model";
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

type CommittingMark = { readonly target: ScreenAnnotationTarget; readonly draft: ScreenAnnotationDraft; readonly untilRevision?: number };

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
  const finishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Cancel the post-gesture observation window on layer teardown.
  useEffect(() => () => clearTimeout(finishTimer.current), []);
  const onPresented = useCallback((frame: PresentedAnnotationFrame) => canvas.current?.presented(frame), []);

  const ink: Ink = { ...style, color: style.color ?? state.access.default_color };
  const rect = visibleFrame(source.size, viewport, pan);
  const allowed = ready && canCapture(state, person.id);
  const nowMs = client.serverNowMs();
  const target = targetFor(state);

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
      canvas.current?.holdInk({
        type: "annotation_presence",
        layer_id: frozen.layerId,
        fence: frozen.fence,
        author: { participant_id: person.id, display_name: person.name, color: live.access.default_color },
        server_at_ms: now,
        expires_at_ms: now + NATIVE_INK_PROOF_TIMEOUT_MS,
        cursor: null,
        draft,
      });
      setFinishingInk(true);
      clearTimeout(finishTimer.current);
      finishTimer.current = setTimeout(() => setFinishingInk(false), NATIVE_INK_PROOF_TIMEOUT_MS);
      void dispatch(frozen, { kind: "commit", draft }).then((result) => {
        if (result?.kind === "accepted") canvas.current?.settleInk(id, result.revision);
        else if (result?.kind !== "delivery_unknown") canvas.current?.settleInk(id, null);
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

  const { layerPresence, localTouch } = layerPresenceFor({ presence, localSample: input.local, committing, target, allowed, open, state, person, nowMs });
  const { save, download, exportFrame } = nativeAnnotationExport({ client, publicationId, source, target, canSave, actions, boardSave, reportError, canvas, exporting });
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
      <ToolButton label="Annotate" icon="pen" onPress={() => setOpen(true)} />
    )
  ) : null;
  const setCanvasReady = (value: boolean) => {
    if (!value) input.cancel();
    setReady(value);
  };

  return (
    <>
      {video(rect, state.layer.burned_in && (open || finishingInk) ? onPresented : undefined, state.layer.burned_in)}
      <AnnotationCanvas ref={canvas} rendererUrl={rendererUrl} onReady={setCanvasReady} onHit={onHit} scene={scene} nowMs={nowMs} localTouch={localTouch} presence={layerPresence} />
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

function AnnotationNote({ onClose, onSave }: { readonly onClose: () => void; readonly onSave: (text: string, note: boolean) => void }): React.JSX.Element {
  const { colors } = useTheme();
  const [body, setBody] = useState("");
  const [note, setNote] = useState(false);
  const text = boundedNote(body);
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.modal}>
        <View style={[styles.panel, { backgroundColor: colors.popover, borderColor: colors.lineStrong }]}>
          <ChalkText>Add text</ChalkText>
          <TextInput autoFocus multiline accessibilityLabel="Annotation text" maxLength={512} value={body} onChangeText={setBody} style={[styles.field, { backgroundColor: colors.raised, color: colors.text }]} />
          <View style={styles.actions}>
            <ToolButton label="Note background" selected={note} onPress={() => setNote(!note)} />
            <ToolButton label="Cancel" onPress={onClose} />
            {text ? <ToolButton label="Add text" selected onPress={() => onSave(text, note)} /> : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function hasSize(size: { readonly width: number; readonly height: number }): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

const styles = StyleSheet.create({
  defaultTray: { position: "absolute", bottom: 0, left: 8, right: 8, alignItems: "center" },
  modal: { flex: 1, justifyContent: "center", alignItems: "center" },
  panel: { width: "88%", maxWidth: 440, borderWidth: 1, borderRadius: corners["2xl"], padding: space[4], gap: space["2-5"] },
  field: { minHeight: 70, padding: space["2-5"], borderRadius: corners.lg },
  actions: { flexDirection: "row", gap: space[1] },
});

function layerPresenceFor({
  presence,
  localSample,
  committing,
  target,
  allowed,
  open,
  state,
  person,
  nowMs,
}: Pick<MatchedProps, "presence" | "state" | "person"> & {
  readonly localSample: ScreenAnnotationPresence | null;
  readonly committing: CommittingMark | null;
  readonly target: ScreenAnnotationTarget;
  readonly allowed: boolean;
  readonly open: boolean;
  readonly nowMs: number;
}) {
  const local = localSample?.fence === target.fence && allowed && open ? localSample : null;
  const waiting = committing && hasTarget(state, committing.target) && (committing.untilRevision === undefined || state.revision < committing.untilRevision);
  const pending: ScreenAnnotationPresence | null =
    waiting && allowed
      ? {
          type: "annotation_presence",
          layer_id: target.layerId,
          fence: target.fence,
          author: { participant_id: person.id, display_name: person.name, color: state.access.default_color },
          server_at_ms: nowMs,
          expires_at_ms: nowMs + 1000,
          cursor: null,
          draft: committing.draft,
        }
      : null;

  const localTouch = state.layer.burned_in && local?.cursor ? { point: local.cursor.point, untilMs: local.server_at_ms + LASER_TRAIL_MS } : undefined;
  const localPreview = local && (state.layer.burned_in ? { ...local, cursor: null } : local);
  const remote = state.layer.burned_in ? [] : presence.filter(({ author }) => author.participant_id !== person.id);
  return { layerPresence: [...remote, ...(pending ? [pending] : []), ...(localPreview ? [localPreview] : [])], localTouch };
}
