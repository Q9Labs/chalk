import CallEnd01Icon from "@hugeicons/core-free-icons/dist/esm/CallEnd01Icon";
import Chat01Icon from "@hugeicons/core-free-icons/dist/esm/Chat01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/dist/esm/MoreHorizontalIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Theme } from "../../ui/theme";

export interface NativeMeetingBottomDockProps {
  simulatorMediaDisabled: boolean;
  isMuted: boolean;
  isCameraOff: boolean;
  unreadChatCount: number;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onOpenChat: () => void;
  onOpenMore: () => void;
  onLeave: () => void;
}

export function NativeMeetingBottomDockAndroid({ simulatorMediaDisabled, isMuted, isCameraOff, unreadChatCount, onToggleAudio, onToggleVideo, onOpenChat, onOpenMore, onLeave }: NativeMeetingBottomDockProps): React.JSX.Element {
  return (
    <View style={styles.bottomDock}>
      <View style={styles.controlPill}>
        <Pressable disabled={simulatorMediaDisabled} onPress={onToggleAudio} style={({ pressed }) => [styles.controlButton, isMuted && styles.controlButtonDanger, simulatorMediaDisabled && styles.controlButtonDisabled, pressed && styles.controlButtonPressed]}>
          <HugeiconsIcon color={isMuted ? "white" : Theme.colors.primary} icon={isMuted ? MicOff01Icon : Mic01Icon} size={22} />
        </Pressable>
        <Pressable disabled={simulatorMediaDisabled} onPress={onToggleVideo} style={({ pressed }) => [styles.controlButton, isCameraOff && styles.controlButtonDanger, simulatorMediaDisabled && styles.controlButtonDisabled, pressed && styles.controlButtonPressed]}>
          <HugeiconsIcon color={isCameraOff ? "white" : Theme.colors.primary} icon={isCameraOff ? VideoOffIcon : Video01Icon} size={22} />
        </Pressable>
        <Pressable onPress={onOpenChat} style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}>
          <HugeiconsIcon color="white" icon={Chat01Icon} size={22} />
          {unreadChatCount > 0 ? (
            <View style={styles.controlBadge}>
              <Text style={styles.controlBadgeText}>{unreadChatCount > 9 ? "9+" : String(unreadChatCount)}</Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable onPress={onOpenMore} style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}>
          <HugeiconsIcon color="white" icon={MoreHorizontalIcon} size={22} />
        </Pressable>
        <Pressable onPress={onLeave} style={({ pressed }) => [styles.controlButton, styles.controlButtonEndCall, pressed && styles.controlButtonPressed]}>
          <HugeiconsIcon color="white" icon={CallEnd01Icon} size={22} />
        </Pressable>
      </View>
    </View>
  );
}

export { NativeMeetingBottomDockAndroid as NativeMeetingBottomDock };

const styles = StyleSheet.create({
  bottomDock: {
    paddingTop: 20,
    paddingBottom: Platform.OS === "ios" ? 38 : 24,
    paddingHorizontal: 24,
    backgroundColor: "#000000",
    borderTopWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    width: "100%",
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
  },
  controlButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  controlButtonDisabled: {
    opacity: 0.45,
  },
  controlButtonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.92 }],
  },
  controlButtonDanger: {
    backgroundColor: "#ea4335",
  },
  controlButtonEndCall: {
    backgroundColor: "#ef4444",
    width: 68,
    borderRadius: 18,
  },
  controlBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: "#000000",
  },
  controlBadgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
  },
});
