import { ChalkWhiteboardViewBounds, type SpaceSnapshot } from "@q9labsai/chalk-client";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { EmbeddedWhiteboard } from "../components/EmbeddedWhiteboard";
import { RtcVideoView } from "../components/RtcVideoView";
import { useSpaceClient } from "../context/space-client-context";
import { useDeviceLayout } from "../frame/device-layout";
import { LandscapeControlsContext } from "../frame/call-controls";
import { useDevScenario } from "../frame/dev-scenario";
import { useMeasuredRef } from "../frame/measurement";
import { createNativeMediaStream } from "../media/native-webrtc";
import type { Frame } from "../motion/MovingFrame";
import { NameTag } from "../primitives/NameTag";
import { useTheme } from "../theme/theme";
import { radii } from "../theme/tokens";
import { useStageView } from "./stage-view";
import { useSpaceSelector } from "./space-selector";

export type SharedContent = { readonly kind: "screen"; readonly sharerId: string } | { readonly kind: "board" };

export type ContentTileProps = {
  readonly content: SharedContent;
  /** The content's box inside the tile, letterboxed to its aspect. */
  readonly inner: Frame;
  /** A small tile in the rows; tapping it brings the content back to the spotlight. */
  readonly mini: boolean;
  readonly onShowInSpotlight: () => void;
};

/** The shared screen or board as one stage tile (`.tile.content`), kept mounted while it moves. */
export const ContentTile = memo(function ContentTile({ content, inner, mini, onShowInSpotlight }: ContentTileProps): React.JSX.Element {
  const { colors } = useTheme();
  const tileStyle = [styles.tile, { backgroundColor: colors.tile }];
  const tileRef = useMeasuredRef<View>("tile.content", tileStyle);
  return (
    <View ref={tileRef} style={tileStyle} testID="tile.content">
      {content.kind === "screen" ? <ScreenShare inner={inner} mini={mini} onShowInSpotlight={onShowInSpotlight} sharerId={content.sharerId} /> : <Board mini={mini} onShowInSpotlight={onShowInSpotlight} />}
    </View>
  );
});

function ScreenShare({ sharerId, inner, mini, onShowInSpotlight }: { readonly sharerId: string; readonly inner: Frame; readonly mini: boolean; readonly onShowInSpotlight: () => void }): React.JSX.Element {
  const { colors } = useTheme();
  const select = useMemo(() => (snapshot: SpaceSnapshot) => snapshot.media.remote.find((media) => media.participantId === sharerId && media.source === "screen")?.track ?? null, [sharerId]);
  const track = useSpaceSelector(select);
  const selectName = useMemo(() => (snapshot: SpaceSnapshot) => snapshot.participants.roster.find((person) => person.participantId === sharerId)?.displayName ?? "", [sharerId]);
  const sharerName = useSpaceSelector(selectName);
  const slot = useDevScenario().screenSlots?.[sharerId];
  const streamURL = useMemo(() => (track ? createNativeMediaStream(track).toURL() : null), [track]);
  const name = `${sharerName.split(" ")[0]}’s screen`;

  return (
    <>
      <View style={[styles.box, { left: inner.x, top: inner.y, width: inner.width, height: inner.height, backgroundColor: colors.tile }]} testID="tile.content.screen">
        {slot ?? (streamURL ? <RtcVideoView objectFit="contain" streamURL={streamURL} style={StyleSheet.absoluteFill} /> : null)}
      </View>
      {mini ? <Pressable accessibilityLabel={`Show ${name} in spotlight`} accessibilityRole="button" onPress={onShowInSpotlight} style={StyleSheet.absoluteFill} testID="tile.content.open" /> : null}
      <NameTag icon="share" name={name} testID="tile.content.name" />
    </>
  );
}

const selectBoard = (snapshot: SpaceSnapshot) => snapshot.whiteboard.engine.status;
const selectRoster = (snapshot: SpaceSnapshot) => snapshot.participants.roster;
const selectSelfId = (snapshot: SpaceSnapshot) => snapshot.self.participantId;
const selectConnection = (snapshot: SpaceSnapshot) => snapshot.connection.status;
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
  const transport = useMemo(() => client.whiteboard.transport(), [client, status]);
  const [capabilities, setCapabilities] = useState({ canDraw: false, canClear: false, viewsAvailable: false });
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
      colors,
    }),
    [mini, phone, landscapeControlsVisible, view.following, selfId, roster, sceneId, status, connectionStatus, capabilities.viewsAvailable, colors],
  );
  const onClose = useCallback(() => {
    view.setBoardOpen(false);
    view.setFollowing(null);
  }, [view.setBoardOpen, view.setFollowing]);
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
});
