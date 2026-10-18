import { memo, type RefObject } from "react";
import { StyleSheet, View } from "react-native";
import type { Arrangement } from "../frame/regions";
import { useMeasuredRef } from "../frame/measurement";
import { IconButton } from "../primitives/IconButton";

export type DockProps = {
  readonly arrangement: Arrangement;
  readonly microphoneOn: boolean;
  readonly cameraOn: boolean;
  readonly onToggleMicrophone: () => void;
  readonly onToggleCamera: () => void;
  readonly onOpenMore: () => void;
  readonly onLeave: () => void;
  readonly moreOpen: boolean;
  /** Set only when Leave opens a menu (hosts), so others hear a plain button. */
  readonly leaveOpen?: boolean;
  readonly moreRef: RefObject<View | null>;
  readonly leaveRef: RefObject<View | null>;
};

/**
 * The call controls region (owned by the dock and chrome lane). This minimal version has the
 * microphone, camera, More and Leave; audio output and the rest arrive with that lane.
 */
export const Dock = memo(function Dock({ arrangement, microphoneOn, cameraOn, onToggleMicrophone, onToggleCamera, onOpenMore, onLeave, moreOpen, leaveOpen, moreRef, leaveRef }: DockProps) {
  const size = arrangement === "pad" ? 44 : 52;
  const dockStyle = [styles.dock, arrangement === "pad" ? styles.pad : arrangement === "landscape" ? styles.landscape : styles.portrait];
  const dockRef = useMeasuredRef<View>("frame.dock", dockStyle);
  return (
    <View accessibilityLabel="Call controls" accessibilityRole="toolbar" pointerEvents="box-none" ref={dockRef} style={dockStyle} testID="frame.dock">
      <IconButton accessibilityLabel={microphoneOn ? "Mute microphone" : "Unmute microphone"} icon={microphoneOn ? "mic" : "micOff"} off={!microphoneOn} onCanvas onPress={onToggleMicrophone} size={size} testID="dock.microphone" />
      <IconButton accessibilityLabel={cameraOn ? "Turn off camera" : "Turn on camera"} icon={cameraOn ? "cam" : "camOff"} off={!cameraOn} onCanvas onPress={onToggleCamera} size={size} testID="dock.camera" />
      <IconButton accessibilityLabel="More options" expanded={moreOpen} icon="more" onCanvas onPress={onOpenMore} ref={moreRef} size={size} testID="dock.more" />
      {arrangement === "pad" ? <View style={styles.gap} /> : null}
      <IconButton accessibilityLabel="Leave call" expanded={leaveOpen} icon="hang" onPress={onLeave} ref={leaveRef} size={size} testID="dock.leave" tone="danger" />
    </View>
  );
});

const styles = StyleSheet.create({
  dock: { flex: 1, flexDirection: "row", alignItems: "center" },
  portrait: { justifyContent: "space-between", paddingHorizontal: 20 },
  landscape: { justifyContent: "center", gap: 14 },
  pad: { justifyContent: "center", gap: 8 },
  gap: { width: 8 },
});
