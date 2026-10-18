import type { Participant } from "@q9labsai/chalk-client";
import { memo, useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useSharedValue, withTiming } from "react-native-reanimated";
import { FaceAvatar } from "../avatar/FaceAvatar";
import { tileAvatarSize } from "../avatar/tile-avatar-size";
import { RtcVideoView } from "../components/RtcVideoView";
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
  const stageStyle = [styles.region, { left: frame.x, top: frame.y, width: frame.width, height: frame.height }];
  const stageRef = useMeasuredRef<View>("frame.stage", stageStyle);

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {/* The stage box itself; tiles are placed in screen points so they can move across regions. */}
      <View pointerEvents="none" ref={stageRef} style={stageStyle} testID="frame.stage" />
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

  return (
    <TileShell cameraOn={streamURL !== null} level={level} speaking={speaking} testID={`tile.${id}`}>
      {streamURL ? (
        <RtcVideoView mirror={isSelf} objectFit="cover" streamURL={streamURL} style={StyleSheet.absoluteFill} />
      ) : (
        <View style={styles.center}>
          <FaceAvatar level={level} lookAround name={participant.displayName} size={avatarSize} style="bold" />
        </View>
      )}
      <NameTag handRaised={participant.handRaised} muted={participant.media.microphone !== "active"} name={name} testID={`tile.${id}.name`} />
    </TileShell>
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1 },
  region: { position: "absolute" },
  center: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
