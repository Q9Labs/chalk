import { forwardRef, memo } from "react";
import { StyleSheet, View, type View as ViewType } from "react-native";
import type { Arrangement } from "../frame/regions";
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
};

/**
 * The call controls region (owned by the dock and chrome lane). This minimal version has the
 * microphone, camera, More and Leave; audio output and the rest arrive with that lane.
 */
export const Dock = memo(
  forwardRef<ViewType, DockProps>(function Dock({ arrangement, microphoneOn, cameraOn, onToggleMicrophone, onToggleCamera, onOpenMore, onLeave, moreOpen }, moreRef) {
    const size = arrangement === "pad" ? 44 : 52;
    return (
      <View accessibilityLabel="Call controls" accessibilityRole="toolbar" pointerEvents="box-none" style={[styles.dock, arrangement === "pad" ? styles.pad : arrangement === "landscape" ? styles.landscape : styles.portrait]} testID="chalk-dock">
        <IconButton accessibilityLabel={microphoneOn ? "Mute microphone" : "Unmute microphone"} icon={microphoneOn ? "mic" : "micOff"} off={!microphoneOn} onCanvas onPress={onToggleMicrophone} size={size} testID="chalk-dock-microphone" />
        <IconButton accessibilityLabel={cameraOn ? "Turn off camera" : "Turn on camera"} icon={cameraOn ? "cam" : "camOff"} off={!cameraOn} onCanvas onPress={onToggleCamera} size={size} testID="chalk-dock-camera" />
        <IconButton accessibilityLabel="More options" expanded={moreOpen} icon="more" onCanvas onPress={onOpenMore} ref={moreRef} size={size} testID="chalk-dock-more" />
        {arrangement === "pad" ? <View style={styles.gap} /> : null}
        <IconButton accessibilityLabel="Leave call" icon="hang" onPress={onLeave} size={size} testID="chalk-dock-leave" tone="danger" />
      </View>
    );
  }),
);

const styles = StyleSheet.create({
  dock: { flex: 1, flexDirection: "row", alignItems: "center" },
  portrait: { justifyContent: "space-between", paddingHorizontal: 20 },
  landscape: { justifyContent: "center", gap: 14 },
  pad: { justifyContent: "center", gap: 8 },
  gap: { width: 8 },
});
