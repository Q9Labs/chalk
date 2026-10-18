import type { Participant } from "@q9labsai/chalk-client";
import { memo, useEffect, useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useSharedValue, withTiming } from "react-native-reanimated";
import { FaceAvatar } from "../avatar/FaceAvatar";
import { tileAvatarSize } from "../avatar/tile-avatar-size";
import { RtcVideoView } from "../components/RtcVideoView";
import { useDevScenario } from "../frame/dev-scenario";
import { useMeasuredRef } from "../frame/measurement";
import { useMedia, useParticipants, useSelf } from "../hooks/space-hooks";
import { createNativeMediaStream } from "../media/native-webrtc";
import { MovingFrame, type Frame } from "../motion/MovingFrame";
import { tileEntering, tileLeaving } from "../motion/presence";
import { timings } from "../motion/motion";
import { NameTag } from "../primitives/NameTag";
import { TileShell } from "../primitives/TileShell";
import { evenGrid } from "./grid";

export type StageProps = {
  /** The stage box in screen points, from `frameRegions`. */
  readonly frame: Frame;
};

/**
 * The stage region (owned by the stage lane). This minimal version lays everyone out in an even
 * grid; each tile is keyed by participant so its video view survives every move.
 */
export const Stage = memo(function Stage({ frame }: StageProps): React.JSX.Element {
  const { roster } = useParticipants();
  const self = useSelf();
  const media = useMedia();
  const frames = useMemo(() => evenGrid(frame, roster.length), [frame, roster.length]);
  // Like the mockup's `.stage`, the stage is a full-screen layer: tiles are placed in screen points
  // inside `frame`, so they can move across regions.
  const stageRef = useMeasuredRef<View>("frame.stage", styles.layer);

  return (
    <View pointerEvents="box-none" ref={stageRef} style={styles.layer} testID="frame.stage">
      {roster.map((participant, index) => {
        const tileFrame = frames[index];
        if (!tileFrame) return null;
        const isSelf = participant.participantId === self.participantId;
        const track = isSelf ? media.local.camera.track : (media.remote.find((remote) => remote.participantId === participant.participantId && remote.source === "camera")?.track ?? null);
        return (
          <MovingFrame frame={tileFrame} key={participant.participantId}>
            <Animated.View entering={tileEntering} exiting={tileLeaving} style={styles.fill}>
              <ParticipantTile avatarSize={tileAvatarSize(tileFrame.width, tileFrame.height)} isSelf={isSelf} participant={participant} track={participant.media.camera === "active" ? track : null} />
            </Animated.View>
          </MovingFrame>
        );
      })}
    </View>
  );
});

type ParticipantTileProps = {
  readonly participant: Participant;
  readonly avatarSize: number;
  readonly isSelf: boolean;
  readonly track: MediaStreamTrack | null;
};

const ParticipantTile = memo(function ParticipantTile({ participant, avatarSize, isSelf, track }: ParticipantTileProps): React.JSX.Element {
  const id = participant.participantId;
  const speaking = participant.presence.speaking;
  const level = useSharedValue(0);
  useEffect(() => {
    level.value = withTiming(speaking ? 0.6 : 0, timings.level);
  }, [level, speaking]);
  const streamURL = useMemo(() => (track ? createNativeMediaStream(track).toURL() : null), [track]);
  const name = isSelf ? `${participant.displayName} (You)` : participant.displayName;
  const video = tileVideo(useDevScenario().videoSlots?.[id], streamURL, isSelf);

  return (
    <TileShell cameraOn={video !== null} level={level} speaking={speaking} testID={`tile.${id}`}>
      {video ?? (
        <View style={styles.center}>
          <FaceAvatar level={level} lookAround name={participant.displayName} size={avatarSize} style="bold" />
        </View>
      )}
      <NameTag handRaised={participant.handRaised} muted={participant.media.microphone !== "active"} name={name} testID={`tile.${id}.name`} />
    </TileShell>
  );
});

/** A harness's fake video slot wins over the camera, so fixtures can show video without media. */
function tileVideo(slot: ReactNode, streamURL: string | null, isSelf: boolean): React.JSX.Element | null {
  if (slot !== undefined) return <View style={StyleSheet.absoluteFill}>{slot}</View>;
  if (streamURL) return <RtcVideoView mirror={isSelf} objectFit="cover" streamURL={streamURL} style={StyleSheet.absoluteFill} />;
  return null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  layer: StyleSheet.absoluteFillObject,
  center: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
