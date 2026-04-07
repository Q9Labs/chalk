import CallEnd01Icon from "@hugeicons/core-free-icons/dist/esm/CallEnd01Icon";
import Chat01Icon from "@hugeicons/core-free-icons/dist/esm/Chat01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import MoreHorizontalIcon from "@hugeicons/core-free-icons/dist/esm/MoreHorizontalIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import ComputerScreenShareIcon from "@hugeicons/core-free-icons/dist/esm/ComputerScreenShareIcon";
import SmileIcon from "@hugeicons/core-free-icons/dist/esm/SmileIcon";
import WavingHand01Icon from "@hugeicons/core-free-icons/dist/esm/WavingHand01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Theme } from "../../ui/theme";
import type { NativeMeetingBottomDockProps } from "./types";

export function NativeMeetingBottomDockIosPad({ 
  simulatorMediaDisabled, 
  isMuted, 
  isCameraOff, 
  isHandRaised,
  isScreenSharing,
  unreadChatCount, 
  participantCount,
  onToggleAudio, 
  onToggleVideo, 
  onToggleHand,
  onToggleScreenShare,
  onOpenChat, 
  onOpenParticipants,
  onOpenReactions,
  onOpenMore, 
  onLeave 
}: NativeMeetingBottomDockProps): React.JSX.Element {
  return (
    <View style={styles.bottomDock}>
      <View style={styles.controlPill}>
        {/* Media & Utility Group */}
        <View style={styles.group}>
          <Pressable 
            disabled={simulatorMediaDisabled} 
            onPress={onToggleAudio} 
            style={({ pressed }) => [
              styles.controlButton, 
              isMuted && styles.buttonDanger, 
              simulatorMediaDisabled && styles.buttonDisabled, 
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color="white" icon={isMuted ? MicOff01Icon : Mic01Icon} size={22} />
          </Pressable>
          
          <Pressable 
            disabled={simulatorMediaDisabled} 
            onPress={onToggleVideo} 
            style={({ pressed }) => [
              styles.controlButton, 
              isCameraOff && styles.buttonDanger, 
              simulatorMediaDisabled && styles.buttonDisabled, 
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color="white" icon={isCameraOff ? VideoOffIcon : Video01Icon} size={22} />
          </Pressable>

          <Pressable 
            onPress={onToggleScreenShare} 
            style={({ pressed }) => [
              styles.controlButton, 
              styles.secondaryButton,
              isScreenSharing && styles.buttonActive,
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color={isScreenSharing ? Theme.colors.primary : "white"} icon={ComputerScreenShareIcon} size={22} />
          </Pressable>

          <Pressable 
            onPress={onToggleHand} 
            style={({ pressed }) => [
              styles.controlButton, 
              styles.secondaryButton,
              isHandRaised && styles.buttonWarning,
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color={isHandRaised ? "white" : "white"} icon={WavingHand01Icon} size={22} />
          </Pressable>
        </View>

        <View style={styles.divider} />

        {/* Social & Collaborative Group */}
        <View style={styles.group}>
          <Pressable 
            onPress={onOpenParticipants} 
            style={({ pressed }) => [
              styles.controlButton, 
              styles.secondaryButton,
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color="white" icon={UserGroupIcon} size={22} />
            <View style={styles.countBadge}>
              <Text style={styles.badgeText}>{participantCount}</Text>
            </View>
          </Pressable>

          <Pressable 
            onPress={onOpenChat} 
            style={({ pressed }) => [
              styles.controlButton, 
              styles.secondaryButton,
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color="white" icon={Chat01Icon} size={22} />
            {unreadChatCount > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.badgeText}>{unreadChatCount > 9 ? "9+" : unreadChatCount}</Text>
              </View>
            )}
          </Pressable>

          <Pressable 
            onPress={onOpenReactions} 
            style={({ pressed }) => [
              styles.controlButton, 
              styles.secondaryButton,
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color="white" icon={SmileIcon} size={22} />
          </Pressable>
        </View>

        <View style={styles.divider} />

        {/* System & Exit Group */}
        <View style={styles.group}>
          <Pressable 
            onPress={onOpenMore} 
            style={({ pressed }) => [
              styles.controlButton, 
              styles.secondaryButton,
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color="white" icon={MoreHorizontalIcon} size={22} />
          </Pressable>

          <Pressable 
            onPress={onLeave} 
            style={({ pressed }) => [
              styles.controlButton, 
              styles.exitButton, 
              pressed && styles.buttonPressed
            ]}
          >
            <HugeiconsIcon color="white" icon={CallEnd01Icon} size={22} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bottomDock: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 100,
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(10, 10, 12, 0.9)",
    borderRadius: 40,
    padding: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
    elevation: 20,
  },
  group: {
    flexDirection: "row",
    gap: 8,
  },
  controlButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
  },
  secondaryButton: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  buttonActive: {
    backgroundColor: "rgba(27, 182, 166, 0.15)",
    borderColor: Theme.colors.primary,
  },
  buttonDanger: {
    backgroundColor: Theme.colors.error,
  },
  buttonWarning: {
    backgroundColor: Theme.colors.warning,
  },
  exitButton: {
    backgroundColor: "#ff4d4d",
    width: 84,
    borderRadius: 20,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonPressed: {
    transform: [{ scale: 0.94 }],
    opacity: 0.8,
  },
  divider: {
    width: 1,
    height: 28,
    backgroundColor: "rgba(255,255,255,0.12)",
    marginHorizontal: 4,
  },
  countBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: "rgba(255,255,255,0.15)",
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#0a0a0b",
  },
  unreadBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: Theme.colors.primary,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#0a0a0b",
  },
  badgeText: {
    color: "white",
    fontSize: 10,
    fontWeight: "900",
  },
});


