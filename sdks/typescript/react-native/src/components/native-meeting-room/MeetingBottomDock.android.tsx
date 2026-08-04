import CallEnd01Icon from "@hugeicons/core-free-icons/dist/esm/CallEnd01Icon";
import Chat01Icon from "@hugeicons/core-free-icons/dist/esm/Chat01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/dist/esm/MoreHorizontalIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Theme } from "../../ui/theme";

import type { MeetingBottomDockProps } from "./types";

export function MeetingBottomDockAndroid({ simulatorMediaDisabled, isMuted, isCameraOff, unreadChatCount, onToggleAudio, onToggleVideo, onOpenChat, onOpenParticipants, onOpenMore, onLeave }: MeetingBottomDockProps): React.JSX.Element {
  return (
    <View style={styles.bottomDock}>
      <View style={styles.controlPill}>
        <DockButton dark disabled={simulatorMediaDisabled} icon={isMuted ? MicOff01Icon : Mic01Icon} label="Microphone" onPress={onToggleAudio} showOffState={isMuted} />
        <DockButton dark disabled={simulatorMediaDisabled} icon={isCameraOff ? VideoOffIcon : Video01Icon} label="Camera" onPress={onToggleVideo} showOffState={isCameraOff} />
        {onOpenParticipants ? <DockButton icon={UserGroupIcon} label="People" onPress={onOpenParticipants} /> : null}
        {onOpenChat ? (
          <Pressable accessibilityLabel="Open Chat" accessibilityRole="button" onPress={onOpenChat} style={({ pressed }) => [styles.control, pressed && styles.controlButtonPressed]}>
            <View style={styles.controlButton}>
              <HugeiconsIcon color={Theme.colors.foreground} icon={Chat01Icon} size={21} />
            </View>
            <Text style={styles.controlLabel}>Chat</Text>
            {unreadChatCount > 0 ? (
              <View style={styles.controlBadge}>
                <Text style={styles.controlBadgeText}>{unreadChatCount > 9 ? "9+" : String(unreadChatCount)}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
        <DockButton icon={MoreHorizontalIcon} label="More" onPress={onOpenMore} />
        <DockButton destructive icon={CallEnd01Icon} label="Leave" onPress={onLeave} />
      </View>
    </View>
  );
}

function DockButton({
  dark = false,
  destructive = false,
  disabled = false,
  icon,
  label,
  onPress,
  showOffState = false,
}: {
  readonly dark?: boolean;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly icon: React.ComponentProps<typeof HugeiconsIcon>["icon"];
  readonly label: string;
  readonly onPress: () => void;
  readonly showOffState?: boolean;
}): React.JSX.Element {
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.control, disabled && styles.controlButtonDisabled, pressed && styles.controlButtonPressed]}>
      <View style={[styles.controlButton, dark && styles.controlButtonDark, destructive && styles.controlButtonEndCall]}>
        <HugeiconsIcon color={dark || destructive ? "#FFFFFF" : Theme.colors.foreground} icon={icon} size={21} />
        {showOffState ? <View style={styles.offDot} /> : null}
      </View>
      <Text style={[styles.controlLabel, destructive && styles.leaveLabel]}>{label}</Text>
    </Pressable>
  );
}

export { MeetingBottomDockAndroid as MeetingBottomDock };

const styles = StyleSheet.create({
  bottomDock: {
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 30 : 16,
    paddingHorizontal: Theme.spacing.md,
    backgroundColor: Theme.colors.surfaceMuted,
    borderTopWidth: 1,
    borderColor: Theme.colors.border,
    width: "100%",
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    gap: 4,
  },
  control: { minWidth: 48, minHeight: 64, alignItems: "center", justifyContent: "flex-start", gap: 5 },
  controlButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.surface,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  controlButtonDark: { backgroundColor: Theme.colors.ink, borderColor: Theme.colors.ink },
  controlButtonDisabled: {
    opacity: 0.45,
  },
  controlButtonPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.92 }],
  },
  controlButtonEndCall: {
    backgroundColor: Theme.colors.error,
    borderColor: Theme.colors.error,
  },
  controlLabel: { color: Theme.colors.ink2, fontSize: 10, fontWeight: "600" },
  leaveLabel: { color: Theme.colors.error },
  offDot: { position: "absolute", right: 1, bottom: 1, width: 9, height: 9, borderRadius: 5, backgroundColor: Theme.colors.error, borderWidth: 2, borderColor: Theme.colors.ink },
  controlBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Theme.colors.chalkBlue,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: Theme.colors.surfaceMuted,
  },
  controlBadgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
  },
});
