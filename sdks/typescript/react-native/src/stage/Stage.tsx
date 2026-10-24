import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSpaceClient } from "../context/space-client-context";
import { useToasts } from "../primitives/toast/ToastStack";
import { ownNativeBoardSession } from "../whiteboard/native-board-session";
import { useDevScenario } from "../frame/dev-scenario";
import { useDeviceLayout } from "../frame/device-layout";
import { useMeasuredRef } from "../frame/measurement";
import { MovingFrame, type Frame } from "../motion/MovingFrame";
import { tileEntering, tileLeaving } from "../motion/presence";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import { elevations, fontFamilies, radii } from "../theme/tokens";
import { ContentTile, type SharedContent } from "./ContentTile";
import { nextStageOrder, stageLayout, type StageItem, type StageOrder } from "./layout";
import { ParticipantTile } from "./ParticipantTile";
import { shallowEqual, useSpaceSelector } from "./space-selector";
import { useStageView } from "./stage-view";
import { TileSheet } from "./TileSheet";

export type StageProps = {
  /** The stage box in screen points, from `frameRegions`. */
  readonly frame: Frame;
  /** The "+N" tile opens People. */
  readonly onOpenPeople: () => void;
};

type Structure = {
  readonly selfId: string | null;
  /** Everyone present, you first, joined by newlines so the selector compares one string. */
  readonly present: string;
  readonly speaker: string | null;
  readonly sharer: string | null;
  readonly board: boolean;
};

/** Only what decides where tiles go, so a mute or a hand raise never re-renders the stage. */
function selectStructure(snapshot: SpaceSnapshot): Structure {
  const selfId = snapshot.self.participantId;
  const { roster } = snapshot.participants;
  const others = roster.filter((person) => person.participantId !== selfId).map((person) => person.participantId);
  const hasSelf = roster.some((person) => person.participantId === selfId);
  return {
    selfId,
    present: (hasSelf && selfId !== null ? [selfId, ...others] : others).join("\n"),
    speaker: roster.find((person) => person.presence.activeSpeaker)?.participantId ?? null,
    sharer: roster.find((person) => person.participantId !== selfId && person.media.screenShare === "active")?.participantId ?? null,
    board: snapshot.whiteboard.engine.presenting,
  };
}

/**
 * The stage: Spotlight or Grid, smart placement of everyone present, and the shared screen or
 * board. Tiles are keyed by participant and moved with `MovingFrame`, so a video view is never
 * remounted by a move, a layout switch or a sheet; only tiles on the stage subscribe to video.
 */
export const Stage = memo(function Stage({ frame, onOpenPeople }: StageProps): React.JSX.Element {
  const client = useSpaceClient();
  const toasts = useToasts();
  useEffect(() => ownNativeBoardSession(client, () => toasts.show({ kind: "error", dismissible: true, message: "Couldn’t open the board. Try again from More." })), [client, toasts]);
  const structure = useSpaceSelector(selectStructure, shallowEqual);
  const selectViewsAvailable = useCallback(() => client.whiteboard.transport()?.supportsViews === true, [client]);
  const viewsAvailable = useSpaceSelector(selectViewsAvailable);
  const view = useStageView();
  const { arrangement } = useDeviceLayout();
  const { shareAspect } = useDevScenario();
  const [sheet, setSheet] = useState<{ readonly id: string | null; readonly open: boolean }>({ id: null, open: false });

  useEffect(() => {
    if (view.following && !structure.present.split("\n").includes(view.following)) view.setFollowing(null);
  }, [structure.present, view.following, view.setFollowing]);

  const present = useMemo(() => (structure.present ? structure.present.split("\n") : []), [structure.present]);
  const [order, setOrder] = useState<StageOrder>({ order: [], spot: null });
  const next = nextStageOrder(order, present, structure.selfId, structure.speaker);
  if (next !== order) setOrder(next);

  useEffect(() => {
    view.setBoardOpen(null);
    view.setFollowing(null);
  }, [structure.board, view.setBoardOpen, view.setFollowing]);

  const boardVisible = view.boardOpen ?? structure.board;
  const content = useMemo<SharedContent | null>(() => (boardVisible ? { kind: "board" } : structure.sharer !== null ? { kind: "screen", sharerId: structure.sharer } : null), [boardVisible, structure.sharer]);
  const pinned = view.pinned !== null && present.includes(view.pinned) ? view.pinned : null;
  const items = useMemo(
    () =>
      stageLayout({
        stage: frame,
        // The iPad uses the phone layout today.
        portrait: arrangement !== "landscape",
        layout: view.layout,
        order: next.order,
        spot: next.spot,
        pinned,
        content: content ? { kind: content.kind, aspect: content.kind === "board" ? null : (shareAspect ?? 16 / 9) } : null,
      }),
    [arrangement, content, frame, next, pinned, shareAspect, view.layout],
  );

  const followTile = useCallback(
    (id: string) => {
      if (!boardVisible || !viewsAvailable || id === structure.selfId) {
        setSheet({ id, open: true });
        return;
      }
      view.showContent();
      view.setFollowing(view.following === id ? null : id);
    },
    [boardVisible, viewsAvailable, structure.selfId, view],
  );
  const openTile = useCallback((id: string) => setSheet({ id, open: true }), []);
  const closeTile = useCallback(() => setSheet((current) => ({ ...current, open: false })), []);
  // Like the mockup's `.stage`, the stage is a full-screen layer: tiles are placed in screen points
  // inside `frame`, so they can move across regions.
  const stageRef = useMeasuredRef<View>("frame.stage", styles.layer);

  return (
    <View pointerEvents="box-none" ref={stageRef} style={styles.layer} testID="frame.stage">
      {items.map((item) => (
        <StageTile content={content} item={item} key={itemKey(item)} mirror={view.mirror} onOpenPeople={onOpenPeople} onOpenTile={followTile} onTileOptions={openTile} following={view.following} onShowContent={view.showContent} peopleCount={present.length} pinned={pinned} />
      ))}
      <TileSheet onClose={closeTile} open={sheet.open} participantId={sheet.id} />
    </View>
  );
});

function itemKey(item: StageItem): string {
  return item.kind === "person" ? `person:${item.id}` : item.kind;
}

type StageTileProps = {
  readonly item: StageItem;
  readonly content: SharedContent | null;
  readonly pinned: string | null;
  readonly mirror: boolean;
  readonly peopleCount: number;
  readonly following: string | null;
  readonly onTileOptions: (participantId: string) => void;
  readonly onOpenTile: (participantId: string) => void;
  readonly onOpenPeople: () => void;
  readonly onShowContent: () => void;
};

function StageTile({ item, content, pinned, mirror, peopleCount, onOpenTile, onOpenPeople, onShowContent, following, onTileOptions }: StageTileProps): React.JSX.Element | null {
  const { scheme } = useTheme();
  const float = item.kind === "person" && item.float;
  return (
    <MovingFrame frame={item.frame} style={float ? [styles.float, { boxShadow: elevations[scheme].floatTile }] : null}>
      <Animated.View entering={tileEntering} exiting={tileLeaving} style={styles.fill}>
        {item.kind === "person" ? (
          <ParticipantTile float={float} height={item.frame.height} id={item.id} mirror={mirror} onOpen={onOpenTile} onOptions={onTileOptions} following={following === item.id} pinned={pinned === item.id} width={item.frame.width} />
        ) : item.kind === "content" && content ? (
          <ContentTile content={content} inner={item.inner} mini={item.mini} onShowInSpotlight={onShowContent} />
        ) : item.kind === "more" ? (
          <MoreTile count={item.count} onPress={onOpenPeople} peopleCount={peopleCount} />
        ) : null}
      </Animated.View>
    </MovingFrame>
  );
}

/** `.more`: the last tile when the rest don't fit, showing how many more people there are. */
const MoreTile = memo(function MoreTile({ count, peopleCount, onPress }: { readonly count: number; readonly peopleCount: number; readonly onPress: () => void }): React.JSX.Element {
  const { colors } = useTheme();
  const restStyle = [styles.more, { backgroundColor: colors.raised }];
  const moreRef = useMeasuredRef<View>("tile.more", restStyle);
  return (
    <Pressable accessibilityLabel={`Show all ${peopleCount} people`} accessibilityRole="button" onPress={onPress} ref={moreRef} style={({ pressed }) => (pressed ? [styles.more, { backgroundColor: colors.hover }] : restStyle)} testID="tile.more">
      <ChalkText style={styles.moreText}>{`+${count}`}</ChalkText>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  layer: StyleSheet.absoluteFillObject,
  float: { zIndex: 12, borderRadius: radii.tilePhone },
  more: { flex: 1, borderRadius: radii.tilePhone, alignItems: "center", justifyContent: "center" },
  moreText: { fontFamily: fontFamilies[600], fontSize: 22, lineHeight: 22 * 1.4 },
});
