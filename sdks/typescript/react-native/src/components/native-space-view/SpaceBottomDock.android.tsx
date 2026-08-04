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
import { useNativeTheme } from "../../ui/native-theme";

import type { SpaceBottomDockProps } from "./types";

export function SpaceBottomDockAndroid({ simulatorMediaDisabled, isMuted, isCameraOff, unreadChatCount, onToggleAudio, onToggleVideo, onOpenChat, onOpenMore, onLeave }: SpaceBottomDockProps): React.JSX.Element {
  const theme = useNativeTheme();
  return (
    <View style={[styles.bottomDock, { backgroundColor: theme.colors.darkCanvas, borderColor: theme.colors.border }]}>
      <View style={styles.controlPill}>
        <Pressable
          disabled={simulatorMediaDisabled}
          onPress={onToggleAudio}
          style={({ pressed }) => [styles.controlButton, { backgroundColor: isMuted ? theme.colors.error : theme.colors.controlsBackground }, simulatorMediaDisabled && styles.controlButtonDisabled, pressed && styles.controlButtonPressed]}
        >
          <HugeiconsIcon color={isMuted ? theme.colors.onDark : theme.colors.primary} icon={isMuted ? MicOff01Icon : Mic01Icon} size={22} />
        </Pressable>
        <Pressable
          disabled={simulatorMediaDisabled}
          onPress={onToggleVideo}
          style={({ pressed }) => [styles.controlButton, { backgroundColor: isCameraOff ? theme.colors.error : theme.colors.controlsBackground }, simulatorMediaDisabled && styles.controlButtonDisabled, pressed && styles.controlButtonPressed]}
        >
          <HugeiconsIcon color={isCameraOff ? theme.colors.onDark : theme.colors.primary} icon={isCameraOff ? VideoOffIcon : Video01Icon} size={22} />
        </Pressable>
        {onOpenChat ? (
          <Pressable onPress={onOpenChat} style={({ pressed }) => [styles.controlButton, { backgroundColor: theme.colors.controlsBackground }, pressed && styles.controlButtonPressed]}>
            <HugeiconsIcon color={theme.colors.onDark} icon={Chat01Icon} size={22} />
            {unreadChatCount > 0 ? (
              <View style={[styles.controlBadge, { backgroundColor: theme.colors.primary, borderColor: theme.colors.darkCanvas }]}>
                <Text style={[styles.controlBadgeText, { color: theme.colors.primaryForeground }]}>{unreadChatCount > 9 ? "9+" : String(unreadChatCount)}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
        <Pressable onPress={onOpenMore} style={({ pressed }) => [styles.controlButton, { backgroundColor: theme.colors.controlsBackground }, pressed && styles.controlButtonPressed]}>
          <HugeiconsIcon color={theme.colors.onDark} icon={MoreHorizontalIcon} size={22} />
        </Pressable>
        <Pressable onPress={onLeave} style={({ pressed }) => [styles.controlButton, styles.controlButtonEndCall, { backgroundColor: theme.colors.error }, pressed && styles.controlButtonPressed]}>
          <HugeiconsIcon color={theme.colors.onDark} icon={CallEnd01Icon} size={22} />
        </Pressable>
      </View>
    </View>
  );
}

export { SpaceBottomDockAndroid as SpaceBottomDock };

const styles = StyleSheet.create({
  bottomDock: {
    paddingTop: 20,
    paddingBottom: Platform.OS === "ios" ? 38 : 24,
    paddingHorizontal: 24,
    backgroundColor: Theme.colors.darkCanvas,
    borderTopWidth: 1,
    borderColor: Theme.colors.whiteOverlay06,
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
    backgroundColor: Theme.colors.whiteOverlay08,
  },
  controlButtonDisabled: {
    opacity: 0.45,
  },
  controlButtonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.92 }],
  },
  controlButtonDanger: {
    backgroundColor: Theme.colors.dangerStrong,
  },
  controlButtonEndCall: {
    backgroundColor: Theme.colors.error,
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
    borderColor: Theme.colors.darkCanvas,
  },
  controlBadgeText: {
    color: Theme.colors.onDark,
    fontSize: 10,
    fontWeight: "800",
  },
});
