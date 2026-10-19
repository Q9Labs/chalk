import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { memo, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSharedValue, withTiming } from "react-native-reanimated";
import { FaceAvatar } from "../avatar/FaceAvatar";
import { tileAvatarSize } from "../avatar/tile-avatar-size";
import { RtcVideoView } from "../components/RtcVideoView";
import { useSpaceClient } from "../context/space-client-context";
import { useDevScenario } from "../frame/dev-scenario";
import { useMeasuredRef } from "../frame/measurement";
import { Icon } from "../icons/Icon";
import { createNativeMediaStream } from "../media/native-webrtc";
import { timings } from "../motion/motion";
import { NameTag, nameTagZone } from "../primitives/NameTag";
import { TileShell } from "../primitives/TileShell";
import { useToasts } from "../primitives/toast/ToastStack";
import { fixed, pressScale } from "../theme/tokens";
import { cameraFacing, otherCamera } from "./camera";
import { shallowEqual, useSpaceSelector } from "./space-selector";

export type ParticipantTileProps = {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** The small tile floating over the other person when two are in the call. */
  readonly float: boolean;
  readonly pinned: boolean;
  /** Your own front-camera video is mirrored while this is on. */
  readonly mirror: boolean;
  readonly onOpen: (participantId: string) => void;
};

type TileModel = {
  readonly name: string;
  readonly isSelf: boolean;
  readonly muted: boolean;
  readonly handRaised: boolean;
  readonly speaking: boolean;
  readonly track: MediaStreamTrack | null;
  readonly back: boolean;
};

/** Below this width your own tile reads "You", because "<name> (You)" leaves no room for the name. */
const SELF_NAME_MIN_WIDTH = 120;

function selectTile(id: string) {
  return (snapshot: SpaceSnapshot): TileModel => {
    const participant = snapshot.participants.roster.find((person) => person.participantId === id);
    const isSelf = snapshot.self.participantId === id;
    const { local, remote } = snapshot.media;
    const track = isSelf ? (local.camera.state === "enabled" ? local.camera.track : null) : participant?.media.camera === "active" ? (remote.find((media) => media.participantId === id && media.source === "camera")?.track ?? null) : null;
    return {
      name: participant?.displayName ?? snapshot.self.displayName ?? "",
      isSelf,
      muted: isSelf ? local.microphone.state !== "enabled" : participant?.media.microphone !== "active",
      handRaised: isSelf ? snapshot.self.handRaised : (participant?.handRaised ?? false),
      speaking: participant?.presence.speaking ?? false,
      track,
      back: isSelf && cameraFacing(snapshot.media) === "back",
    };
  };
}

/**
 * One person's tile: their camera, or their bold facehash when the camera is off, the name tag,
 * and the speaking ring. It subscribes to that person alone, so nobody else's change re-renders
 * it, and the stage keeps it mounted across every move so the video view keeps its surface.
 */
export const ParticipantTile = memo(function ParticipantTile({ id, width, height, float, pinned, mirror, onOpen }: ParticipantTileProps): React.JSX.Element {
  const select = useMemo(() => selectTile(id), [id]);
  const tile = useSpaceSelector(select, shallowEqual);
  const slot = useDevScenario().videoSlots?.[id];
  const level = useSharedValue(0);
  useEffect(() => {
    level.value = withTiming(tile.speaking ? 0.6 : 0, timings.level);
  }, [level, tile.speaking]);

  const streamURL = useMemo(() => (tile.track ? createNativeMediaStream(tile.track).toURL() : null), [tile.track]);
  const video = tileVideo(slot, streamURL, tile.isSelf && !tile.back && mirror);
  const youOnly = tile.isSelf && (float || width < SELF_NAME_MIN_WIDTH);
  const name = youOnly ? "You" : tile.name;
  const you = tile.isSelf && !youOnly;
  const state = `${tile.muted ? ", microphone off" : ""}${tile.handRaised ? ", hand raised" : ""}`;
  const hitRef = useMeasuredRef<View>(`tile.${id}.open`, StyleSheet.absoluteFill);
  const label = `Options for ${tile.name}${tile.isSelf ? " (you)" : ""}${pinned ? ", pinned" : ""}${state}`;

  return (
    <TileShell cameraOn={video !== null} level={level} speaking={tile.speaking} testID={`tile.${id}`}>
      {video ?? (
        <View style={styles.center}>
          <FaceAvatar level={level} lookAround name={tile.name} size={tileAvatarSize(width, height - nameTagZone)} style="bold" />
        </View>
      )}
      <Pressable accessibilityHint="Opens a sheet" accessibilityLabel={label} accessibilityRole="button" onPress={() => onOpen(id)} ref={hitRef} style={StyleSheet.absoluteFill} testID={`tile.${id}.open`} />
      <NameTag handRaised={tile.handRaised} muted={tile.muted} name={name} pinned={pinned} testID={`tile.${id}.name`} you={you} />
      {tile.isSelf && video !== null ? <FlipCameraButton back={tile.back} float={float} testID={`tile.${id}.flip`} /> : null}
    </TileShell>
  );
});

/** A harness's fake video slot wins over the camera, so fixtures can show video without media. */
function tileVideo(slot: ReactNode, streamURL: string | null, mirror: boolean): React.JSX.Element | null {
  if (slot !== undefined) return <View style={[StyleSheet.absoluteFill, mirror ? styles.mirrored : null]}>{slot}</View>;
  if (streamURL) return <RtcVideoView mirror={mirror} objectFit="cover" streamURL={streamURL} style={StyleSheet.absoluteFill} />;
  return null;
}

const selectOtherCamera = (snapshot: SpaceSnapshot) => otherCamera(snapshot.media)?.deviceId ?? null;

/** `.flip`: switches between the front and back camera, top right of your own video. */
function FlipCameraButton({ back, float, testID }: { readonly back: boolean; readonly float: boolean; readonly testID: string }): React.JSX.Element | null {
  const client = useSpaceClient();
  const toasts = useToasts();
  const other = useSpaceSelector(selectOtherCamera);
  const flip = useCallback(() => {
    if (other === null) return;
    client.media.selectCamera(other).catch(() => toasts.show({ kind: "error", dismissible: true, message: "Couldn't switch the camera." }));
  }, [client, other, toasts]);
  if (other === null) return null;

  return (
    <Pressable accessibilityLabel={`Switch to the ${back ? "front" : "back"} camera`} accessibilityRole="button" onPress={flip} style={[styles.flip, float ? styles.flipFloat : null]} testID={testID}>
      {({ pressed }) => (
        <View style={[styles.flipKnob, { backgroundColor: pressed ? fixed.overlayPressed : fixed.overlay }, pressed ? styles.flipPressed : null]}>
          <Icon color={fixed.overlayText} name="flip" size={17} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Centred above the name tag, so a short strip tile never hides the face behind the tag.
  center: { ...StyleSheet.absoluteFillObject, bottom: nameTagZone, alignItems: "center", justifyContent: "center" },
  mirrored: { transform: [{ scaleX: -1 }] },
  flip: { position: "absolute", top: 2, right: 2, width: 44, height: 44, alignItems: "center", justifyContent: "center", zIndex: 4 },
  flipFloat: { top: 0, right: 0 },
  flipKnob: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  flipPressed: { transform: [{ scale: pressScale.small }] },
});
