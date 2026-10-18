import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { memo, useMemo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { EmbeddedWhiteboard } from "../components/EmbeddedWhiteboard";
import { RtcVideoView } from "../components/RtcVideoView";
import { useSpaceClient } from "../context/space-client-context";
import { useDevScenario } from "../frame/dev-scenario";
import { useMeasuredRef } from "../frame/measurement";
import { Icon } from "../icons/Icon";
import { createNativeMediaStream } from "../media/native-webrtc";
import type { Frame } from "../motion/MovingFrame";
import { ChalkText } from "../primitives/ChalkText";
import { NameTag } from "../primitives/NameTag";
import { useTheme } from "../theme/theme";
import { radii } from "../theme/tokens";
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

/** The shared board, view-only today, through the embedded whiteboard. It loads only while a board is shared. */
function Board({ mini, onShowInSpotlight }: { readonly mini: boolean; readonly onShowInSpotlight: () => void }): React.JSX.Element {
  const client = useSpaceClient();
  const { colors, scheme } = useTheme();
  const status = useSpaceSelector(selectBoard);
  const chipStyle = [styles.viewOnly, { backgroundColor: colors.surface, borderColor: colors.lineStrong }];
  const chipRef = useMeasuredRef<View>("tile.content.view-only", chipStyle);
  // The transport changes when the engine resubscribes.
  const transport = useMemo(() => client.whiteboard.transport(), [client, status]);
  const journeyId = useRef(`board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`).current;

  return (
    <>
      {transport ? <EmbeddedWhiteboard canClear={false} canDraw={false} journeyId={journeyId} style={StyleSheet.absoluteFill} testID="tile.content.board" theme={scheme} transport={transport} /> : null}
      {mini ? (
        <>
          <Pressable accessibilityLabel="Show the board in spotlight" accessibilityRole="button" onPress={onShowInSpotlight} style={StyleSheet.absoluteFill} testID="tile.content.open" />
          <NameTag icon="pen" name="Board" testID="tile.content.name" />
        </>
      ) : (
        <View accessibilityLiveRegion="polite" accessibilityRole="text" accessible ref={chipRef} style={chipStyle} testID="tile.content.view-only">
          <Icon color={colors.textMuted} name="lock" size={16} />
          <ChalkText tone="textSoft" variant="section">
            View only
          </ChalkText>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  tile: { flex: 1, overflow: "hidden", borderRadius: radii.tilePhone },
  box: { position: "absolute", overflow: "hidden" },
  // `.vchip`: a 30 pt pill 12 pt in from the board's top-left corner, with a one-pixel ring.
  viewOnly: { position: "absolute", left: 12, top: 12, height: 30, paddingHorizontal: 12, borderRadius: radii.round, borderWidth: 1, flexDirection: "row", alignItems: "center", gap: 6, zIndex: 3 },
});
