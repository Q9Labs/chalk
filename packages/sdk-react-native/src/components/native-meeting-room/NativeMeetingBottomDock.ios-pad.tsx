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

export function NativeMeetingBottomDockIosPad({ simulatorMediaDisabled, isMuted, isCameraOff, unreadChatCount, onToggleAudio, onToggleVideo, onOpenChat, onOpenMore, onLeave }: NativeMeetingBottomDockProps): React.JSX.Element {
  return (
    <View style={styles.bottomDock}>
      <View style={styles.controlPill}>
        {/* Media Group */}
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
          <HugeiconsIcon 
            color="white" 
            icon={isMuted ? MicOff01Icon : Mic01Icon} 
            size={24} 
          />
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
          <HugeiconsIcon 
            color="white" 
            icon={isCameraOff ? VideoOffIcon : Video01Icon} 
            size={24} 
          />
        </Pressable>

        <View style={styles.divider} />

        {/* Action Group */}
        <Pressable 
          onPress={onOpenChat} 
          style={({ pressed }) => [
            styles.controlButton, 
            styles.secondaryButton,
            pressed && styles.buttonPressed
          ]}
        >
          <HugeiconsIcon color="white" icon={Chat01Icon} size={24} />
          {unreadChatCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unreadChatCount > 9 ? "9+" : unreadChatCount}</Text>
            </View>
          )}
        </Pressable>

        <Pressable 
          onPress={onOpenMore} 
          style={({ pressed }) => [
            styles.controlButton, 
            styles.secondaryButton,
            pressed && styles.buttonPressed
          ]}
        >
          <HugeiconsIcon color="white" icon={MoreHorizontalIcon} size={24} />
        </Pressable>

        <View style={styles.divider} />

        {/* Exit Action */}
        <Pressable 
          onPress={onLeave} 
          style={({ pressed }) => [
            styles.controlButton, 
            styles.exitButton, 
            pressed && styles.buttonPressed
          ]}
        >
          <HugeiconsIcon color="white" icon={CallEnd01Icon} size={24} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bottomDock: {
    position: "absolute",
    bottom: Platform.OS === "ios" ? 32 : 24,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 100,
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(10, 10, 12, 0.88)",
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
  controlButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
  },
  secondaryButton: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  buttonDanger: {
    backgroundColor: Theme.colors.error,
  },
  exitButton: {
    backgroundColor: "#ff4d4d",
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
    height: 32,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginHorizontal: 4,
  },
  badge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: Theme.colors.primary,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#0a0a0b",
    paddingHorizontal: 4,
  },
  badgeText: {
    color: "white",
    fontSize: 10,
    fontWeight: "900",
  },
});

