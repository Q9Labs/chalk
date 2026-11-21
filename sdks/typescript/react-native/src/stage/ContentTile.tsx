import { ChalkWhiteboardViewBounds, type SpaceSnapshot } from "@q9labsai/chalk-client";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { EmbeddedWhiteboard } from "../components/EmbeddedWhiteboard";
import { RtcVideoView } from "../components/RtcVideoView";
import { useSpaceClient } from "../context/space-client-context";
import { useDeviceLayout } from "../frame/device-layout";
import { LandscapeControlsContext } from "../frame/call-controls";
import { useDevScenario } from "../dev-scenario";
import { frameRegions } from "../frame/regions";
import { Portal } from "../frame/portal";
import { useMeasuredRef } from "../frame/measurement";
import { createNativeMediaStream } from "../media/native-webrtc";
import type { Frame } from "../motion/MovingFrame";
import { useToasts } from "../primitives/toast/ToastStack";
import { NameTag } from "../primitives/NameTag";
import { ScreenAnnotationLayer } from "../screen-annotation/ScreenAnnotationLayer";
import { matchLayer, type StageAnnotation } from "../screen-annotation/model";
import { useNativeAnnotationSource } from "../screen-annotation/use-native-annotation-source";
import { useTheme } from "../theme/theme";
import { radii } from "../theme/tokens";
import { useStageView } from "./stage-view";
import { useSpaceSelector } from "./space-selector";

export type SharedContent = { readonly kind: "screen"; readonly sharerId: string } | { readonly kind: "board" };

export type ContentTileProps = {
  readonly annotation?: StageAnnotation;
  readonly content: SharedContent;
  /** The content's box inside the tile, letterboxed to its aspect. */
  readonly inner: Frame;
  /** A small tile in the rows; tapping it brings the content back to the spotlight. */
  readonly mini: boolean;
  readonly onShowInSpotlight: () => void;
};

/** The shared screen or board as one stage tile (`.tile.content`), kept mounted while it moves. */
export const ContentTile = memo(function ContentTile({ annotation, content, inner, mini, onShowInSpotlight }: ContentTileProps): React.JSX.Element {
  const { colors } = useTheme();
  const tileStyle = [styles.tile, { backgroundColor: colors.tile }];
  const tileRef = useMeasuredRef<View>("tile.content", tileStyle);
  return (
    <View ref={tileRef} style={tileStyle} testID="tile.content">
      {content.kind === "screen" ? <ScreenShare annotation={annotation} inner={inner} mini={mini} onShowInSpotlight={onShowInSpotlight} sharerId={content.sharerId} /> : <Board mini={mini} onShowInSpotlight={onShowInSpotlight} />}
    </View>
  );
});

function ScreenShare({ annotation, sharerId, inner, mini, onShowInSpotlight }: { readonly annotation?: StageAnnotation; readonly sharerId: string; readonly inner: Frame; readonly mini: boolean; readonly onShowInSpotlight: () => void }): React.JSX.Element {
  const { colors } = useTheme();
  const selectScreen = useMemo(() => (snapshot: SpaceSnapshot) => {
    if (Platform.OS === "android" && snapshot.self.participantId === sharerId) return snapshot.media.screenShare.track;
    return snapshot.media.remote.find((media) => media.participantId === sharerId && media.source === "screen")?.track ?? null;
  }, [sharerId]);
  const selectPublication = useMemo(() => (snapshot: SpaceSnapshot) => {
    if (Platform.OS === "android" && snapshot.self.participantId === sharerId) {
      return snapshot.participants.roster.find((person) => person.participantId === sharerId)?.media.screenSharePublicationId ?? null;
    }
    return snapshot.media.remote.find((media) => media.participantId === sharerId && media.source === "screen")?.publicationId ?? null;
  }, [sharerId]);
  const selectPlayable = useMemo(() => (snapshot: SpaceSnapshot) => !snapshot.media.remote.some((media) =>
    media.participantId === sharerId && media.source === "screen" && media.pausedForNetwork), [sharerId]);
  const playable = useSpaceSelector(selectPlayable);
  const track = useSpaceSelector(selectScreen);
  const publicationId = useSpaceSelector(selectPublication);
  const selectName = useMemo(() => (snapshot: SpaceSnapshot) => snapshot.participants.roster.find((person) => person.participantId === sharerId)?.displayName ?? "", [sharerId]);
  const sharerName = useSpaceSelector(selectName);
  const selfId = useSpaceSelector(selectSelfId);
  const slot = useDevScenario().screenSlots?.[sharerId];
  const streamURL = useMemo(() => (track ? createNativeMediaStream(track).toURL() : null), [track]);
  const name = selfId === sharerId ? "Your screen" : `${sharerName.split(" ")[0]}’s screen`;
  const annotate = playable && !mini && annotation && publicationId && selfId && (!annotation.publicationId || annotation.publicationId === publicationId);

  return (
    <>
      <View style={[styles.box, { left: inner.x, top: inner.y, width: inner.width, height: inner.height, backgroundColor: colors.tile }]} testID="tile.content.screen">
        {slot ?? (streamURL ? annotate
          ? <AnnotationScreenShare annotation={annotation} inner={inner} publicationId={publicationId} selfId={selfId} streamURL={streamURL} />
          : <RtcVideoView objectFit="contain" streamURL={streamURL} style={StyleSheet.absoluteFill} />
          : null)}
      </View>
      {mini ? <Pressable accessibilityLabel={`Show ${name} in spotlight`} accessibilityRole="button" onPress={onShowInSpotlight} style={StyleSheet.absoluteFill} testID="tile.content.open" /> : null}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}><NameTag icon="share" name={name} testID="tile.content.name" /></View>
    </>
  );
}

function AnnotationScreenShare({ annotation, inner, publicationId, selfId, streamURL }: { readonly annotation: StageAnnotation; readonly inner: Frame; readonly publicationId: string; readonly selfId: string; readonly streamURL: string }): React.JSX.Element {
  const { client, actions } = annotation;
  const device = useDeviceLayout();
  const dock = frameRegions(device.arrangement, device.width, device.height, device.insets).dock;
  const toasts = useToasts();
  const roster = useSpaceSelector(selectRoster);
  const access = useSpaceSelector(selectAccess);
  const selectCanSave = (snapshot: SpaceSnapshot) => snapshot.self.can("drawWhiteboard");
  const canSave = useSpaceSelector(selectCanSave);
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getMatch = useCallback(() => matchLayer(client, publicationId) !== null, [client, publicationId]);
  const matched = useSyncExternalStore(subscribe, getMatch, getMatch);
  const source = useNativeAnnotationSource(matched ? streamURL : null);
  const viewport = { x: 0, y: 0, width: inner.width, height: inner.height };
  const ownName = roster.find((person) => person.participantId === selfId)?.displayName ?? "";
  const people = roster.filter((person) => person.participantId !== selfId).map((person) => ({
    id: person.participantId,
    name: person.displayName,
    manages: person.capabilities.includes("manageWhiteboard"),
    canDraw: access.permissions.find((permission) => permission.participantId === person.participantId)?.canDraw ??
      (access.policy === "everyone" && person.capabilities.includes("drawWhiteboard")),
  }));
  return <ScreenAnnotationLayer
    client={client}
    actions={actions}
    canSave={canSave}
    publicationId={publicationId}
    person={{ id: selfId, name: ownName }}
    people={people}
    source={source}
    viewport={viewport}
    video={(rect) => <RtcVideoView objectFit="contain" streamURL={streamURL} style={[styles.box, { left: rect.x, top: rect.y, width: rect.width, height: rect.height }]} />}
    controls={(tray: ReactNode) => tray ? <Portal layer="annotation">
      <View pointerEvents="box-none" style={[styles.annotationTray, { bottom: device.height - dock.y + 8, left: device.insets.left + 8, right: device.insets.right + 8 }]}>{tray}</View>
    </Portal> : null}
    reportError={(message) => toasts.show({ kind: "error", dismissible: true, message })}
  />;
}

const selectBoard = (snapshot: SpaceSnapshot) => snapshot.whiteboard.engine.status;
const selectRoster = (snapshot: SpaceSnapshot) => snapshot.participants.roster;
const selectSelfId = (snapshot: SpaceSnapshot) => snapshot.self.participantId;
const selectConnection = (snapshot: SpaceSnapshot) => snapshot.connection.status;
const selectAccess = (snapshot: SpaceSnapshot) => snapshot.whiteboard.access;
const selectCanManage = (snapshot: SpaceSnapshot) => snapshot.self.can("manageWhiteboard");
const selectSceneId = (snapshot: SpaceSnapshot) => snapshot.whiteboard.engine.sceneId;

/** The shared board uses the same renderer, tools and view protocol as web. */
function Board({ mini, onShowInSpotlight }: { readonly mini: boolean; readonly onShowInSpotlight: () => void }): React.JSX.Element {
  const client = useSpaceClient();
  const { colors, scheme } = useTheme();
  const view = useStageView();
  const { width, height } = useDeviceLayout();
  const landscapeControlsVisible = useContext(LandscapeControlsContext);
  const phone = Math.min(width, height) < 600;
  const status = useSpaceSelector(selectBoard);
  const roster = useSpaceSelector(selectRoster);
  const selfId = useSpaceSelector(selectSelfId);
  const connectionStatus = useSpaceSelector(selectConnection);
  const sceneId = useSpaceSelector(selectSceneId);
  const access = useSpaceSelector(selectAccess);
  const canManage = useSpaceSelector(selectCanManage);
  const toasts = useToasts();
  const transport = useMemo(() => client.whiteboard.transport(), [client, status]);
  const [capabilities, setCapabilities] = useState({ canDraw: false, canClear: false, viewsAvailable: false });
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Mirror whiteboard capabilities from transport summaries; return the summary unsubscribe function.
  useEffect(() => transport?.subscribeSummary?.((summary) => setCapabilities({ canDraw: summary.canDraw, canClear: summary.canClear, viewsAvailable: transport.supportsViews === true })), [transport]);
  const board = useMemo(
    () => ({
      primary: !mini,
      phone,
      landscapeControlsVisible,
      following: view.following,
      ownParticipantId: selfId,
      people: roster.map((person) => ({ id: person.participantId, displayName: person.displayName })),
      viewBounds: ChalkWhiteboardViewBounds,
      sceneId,
      sceneStatus: status,
      connectionStatus,
      viewsAvailable: capabilities.viewsAvailable,
      ...(canManage && access.policy !== null && transport?.setDrawPolicy
        ? {
            whoCanDraw: {
              policy: access.policy,
              people: roster
                .filter((person) => person.participantId !== selfId && !person.capabilities.includes("manageWhiteboard"))
                .map((person) => ({ id: person.participantId, name: person.displayName, picked: access.permissions.some((permission) => permission.participantId === person.participantId && permission.canDraw) })),
            },
          }
        : {}),
      colors,
    }),
    [mini, phone, landscapeControlsVisible, view.following, selfId, roster, sceneId, status, connectionStatus, capabilities.viewsAvailable, canManage, access, transport, colors],
  );
  const onClose = useCallback(() => {
    void (async () => {
      if (canManage) await transport?.setPresentation?.(false);
      view.setBoardOpen(false);
      view.setFollowing(null);
    })().catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn’t close the board. Try again." }));
  }, [canManage, transport, toasts, view.setBoardOpen, view.setFollowing]);
  const journeyId = useRef(`board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`).current;

  return (
    <>
      {transport ? (
        <EmbeddedWhiteboard board={board} canClear={capabilities.canClear} canDraw={!mini && capabilities.canDraw} journeyId={journeyId} onCloseBoard={onClose} onFollow={view.setFollowing} style={StyleSheet.absoluteFill} testID="tile.content.board" theme={scheme} transport={transport} />
      ) : null}
      {mini ? (
        <>
          <Pressable accessibilityLabel="Show the board in spotlight" accessibilityRole="button" onPress={onShowInSpotlight} style={StyleSheet.absoluteFill} testID="tile.content.open" />
          <NameTag icon="pen" name="Board" testID="tile.content.name" />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  tile: { flex: 1, overflow: "hidden", borderRadius: radii.tilePhone },
  box: { position: "absolute", overflow: "hidden" },
  annotationTray: { position: "absolute", maxHeight: "50%", alignItems: "center" },
});
