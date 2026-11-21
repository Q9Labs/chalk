import type {
  ScreenAnnotationCommand,
  ScreenAnnotationDraft,
  ScreenAnnotationPoint,
  ScreenAnnotationPresence,
  ScreenAnnotationState,
  ScreenAnnotationTarget,
} from "@q9labsai/chalk-client";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Modal, StyleSheet, TextInput, View } from "react-native";
import type { Frame } from "../motion/MovingFrame";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import { AnnotationCanvas, type AnnotationCanvasHandle } from "./AnnotationCanvas";
import { ScreenAnnotationToolbar, ToolButton, type ScreenAnnotationToolbarProps } from "./ScreenAnnotationToolbar";
import {
  boundedNote, canCapture, hasTarget, initialViewport, matchLayer, targetFor, visibleCommittedMarks, visibleFrame,
  type Ink, type ScreenAnnotationActions, type ScreenAnnotationOptions, type ScreenAnnotationSource,
} from "./model";
import { shareAnnotationPng } from "./export-native-png";
import { useAnnotationInput, type TextAnchor } from "./use-annotation-input";

type ExportAction = NonNullable<ScreenAnnotationActions["downloadPng"]>;

export type ScreenAnnotationLayerProps = ScreenAnnotationOptions & {
  readonly person: { readonly id: string; readonly name: string };
  readonly people?: ScreenAnnotationToolbarProps["people"];
  readonly canSave?: boolean;
  readonly source: ScreenAnnotationSource | null;
  readonly viewport: Frame;
  /** Render the video in exactly this native view rectangle, without another transform. */
  readonly video: (frame: Frame) => ReactNode;
  readonly controls?: (tray: ReactNode) => ReactNode;
  readonly reportError?: (message: string) => void;
};

export function ScreenAnnotationLayer(props: ScreenAnnotationLayerProps): React.JSX.Element {
  const { client, publicationId, source, viewport, video } = props;
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (snapshot.status !== "ready" || !snapshot.state || snapshot.state.layer.publication_id !== publicationId ||
      !source?.rendererUrl?.startsWith("file:///") || !hasSize(source.size) || !hasSize(viewport)) {
    return <>{video(viewport)}</>;
  }
  return <MatchedLayer
    key={snapshot.state.layer.layer_id}
    {...props}
    rendererUrl={source.rendererUrl}
    source={source}
    presence={snapshot.presence}
    state={snapshot.state}
  />;
}

type MatchedProps = ScreenAnnotationLayerProps & {
  readonly presence: readonly ScreenAnnotationPresence[];
  readonly rendererUrl: string;
  readonly source: ScreenAnnotationSource;
  readonly state: ScreenAnnotationState;
};

function MatchedLayer({ actions, canSave, client, controls, people, person, presence, publicationId, rendererUrl, reportError, source, state, video, viewport }: MatchedProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [style, setStyle] = useState<Omit<Ink, "color"> & { readonly color: string | null }>({ tool: "pen", lifetime: "fade", width: 193, stamp: "check", color: null });
  const [pan, setPan] = useState(initialViewport);
  const [textAnchor, setTextAnchor] = useState<TextAnchor | null>(null);
  const [committing, setCommitting] = useState<{ readonly target: ScreenAnnotationTarget; readonly draft: ScreenAnnotationDraft; readonly untilRevision?: number } | null>(null);
  const erase = useRef<{ readonly id: number; readonly target: ScreenAnnotationTarget } | null>(null);
  const eraseCounter = useRef(0);
  const canvas = useRef<AnnotationCanvasHandle>(null);

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
    setCommitting({ draft, target: frozen });
    void dispatch(frozen, { kind: "commit", draft }).then((result) => {
      setCommitting((current) => current?.draft.mark_id !== draft.mark_id
        ? current
        : result?.kind === "accepted" ? { ...current, untilRevision: result.revision } : null);
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
    client, publicationId, participantId: person.id, displayName: person.name, color: state.access.default_color,
    ink, rect, viewport: pan, onViewport: setPan, onText: setTextAnchor,
    onErase: (point: ScreenAnnotationPoint, frozen) => {
      const id = ++eraseCounter.current;
      erase.current = { id, target: frozen };
      canvas.current?.hit(id, point, state.access.can_moderate ? null : person.id);
    },
    onCommit: commit,
  });

  const local = input.local?.fence === target.fence && allowed && open ? input.local : null;
  const waiting = committing && hasTarget(state, committing.target) && (committing.untilRevision === undefined || state.revision < committing.untilRevision);
  const pending: ScreenAnnotationPresence | null = waiting && allowed ? {
    type: "annotation_presence",
    layer_id: target.layerId,
    fence: target.fence,
    author: { participant_id: person.id, display_name: person.name, color: state.access.default_color },
    server_at_ms: nowMs,
    expires_at_ms: nowMs + 1000,
    cursor: null,
    draft: committing.draft,
  } : null;

  async function exportFrame(action: ExportAction) {
    const live = matchLayer(client, publicationId);
    if (!source.captureFrame || !hasTarget(live, target)) return;
    const at = client.serverNowMs();
    const marks = visibleCommittedMarks(live, at);
    try {
      const frame = await source.captureFrame();
      if (frame === null) {
        reportError?.("Wait for the shared video to resume before saving a frame.");
        return;
      }
      try {
        await action({ publicationId, size: source.size, image: frame.image, marks, nowMs: at });
      } finally {
        frame.release?.();
      }
    } catch {
      reportError?.("Couldn’t save the marked frame.");
    }
  }

  const save = canSave && actions?.saveToWhiteboard && source.captureFrame ? actions.saveToWhiteboard : null;
  const download: ExportAction | null = source.captureFrame ? actions?.downloadPng ?? (async ({ image, ...frame }) => {
    if (!canvas.current || typeof image !== "string") throw new Error("No native frame");
    await shareAnnotationPng(await canvas.current.png({ ...frame, image }));
  }) : null;
  const scene = useMemo(() => ({
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    clip: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
    marks: state.marks, paused: state.paused, sharerId: state.layer.sharer_id,
  }), [rect.x, rect.y, rect.width, rect.height, viewport.x, viewport.y, viewport.width, viewport.height, state.marks, state.paused, state.layer.sharer_id]);
  const tray = ready
    ? open ? <ScreenAnnotationToolbar
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
      /> : <ToolButton label="Annotate" icon="pen" onPress={() => setOpen(true)} />
    : null;
  const setCanvasReady = (value: boolean) => {
    if (!value) input.cancel();
    setReady(value);
  };

  return <>
    {video(rect)}
    <AnnotationCanvas
      ref={canvas}
      rendererUrl={rendererUrl}
      onReady={setCanvasReady}
      onHit={onHit}
      scene={scene}
      nowMs={nowMs}
      presence={[...presence.filter(({ author }) => author.participant_id !== person.id), ...(pending ? [pending] : []), ...(local ? [local] : [])]}
    />
    {open && allowed ? <View
      accessible={false}
      style={StyleSheet.absoluteFill}
      testID="annotation.surface"
      onStartShouldSetResponder={() => true}
      onResponderStart={input.onStart}
      onResponderMove={input.onMove}
      onResponderEnd={input.onEnd}
      onResponderTerminate={input.cancel}
    /> : null}
    {controls ? controls(tray) : <View pointerEvents="box-none" style={styles.defaultTray}>{tray}</View>}
    {textAnchor && hasTarget(state, textAnchor.target) && allowed ? <AnnotationNote
      onClose={() => setTextAnchor(null)}
      onSave={(text, note) => {
        const { at, draft, target: frozen } = textAnchor;
        setTextAnchor(null);
        commit({ ...draft, shape: { kind: "text", at, text, note } }, frozen);
      }}
    /> : null}
  </>;
}

function AnnotationNote({ onClose, onSave }: { readonly onClose: () => void; readonly onSave: (text: string, note: boolean) => void }): React.JSX.Element {
  const { colors } = useTheme();
  const [body, setBody] = useState("");
  const [note, setNote] = useState(false);
  const text = boundedNote(body);
  return <Modal transparent visible animationType="fade" onRequestClose={onClose}>
    <View style={styles.modal}>
      <View style={[styles.panel, { backgroundColor: colors.popover, borderColor: colors.lineStrong }]}>
        <ChalkText>Add text</ChalkText>
        <TextInput
          autoFocus
          multiline
          accessibilityLabel="Annotation text"
          maxLength={512}
          value={body}
          onChangeText={setBody}
          style={[styles.field, { backgroundColor: colors.raised, color: colors.text }]}
        />
        <View style={styles.actions}>
          <ToolButton label="Note background" selected={note} onPress={() => setNote(!note)} />
          <ToolButton label="Cancel" onPress={onClose} />
          {text ? <ToolButton label="Add text" selected onPress={() => onSave(text, note)} /> : null}
        </View>
      </View>
    </View>
  </Modal>;
}

function hasSize(size: { readonly width: number; readonly height: number }): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

const styles = StyleSheet.create({
  defaultTray: { position: "absolute", bottom: 0, left: 8, right: 8, alignItems: "center" },
  modal: { flex: 1, justifyContent: "center", alignItems: "center" },
  panel: { width: "88%", maxWidth: 440, borderWidth: 1, borderRadius: 18, padding: 14, gap: 10 },
  field: { minHeight: 70, padding: 10, borderRadius: 8 },
  actions: { flexDirection: "row", gap: 4 },
});
