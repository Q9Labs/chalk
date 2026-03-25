import { CallEnd01Icon, Chat01Icon, ComputerScreenShareIcon, Link01Icon, Mic01Icon, MicOff01Icon, Presentation01Icon, RecordIcon, Settings01Icon, SmileIcon, TextFontIcon, UserGroupIcon, Video01Icon, VideoOffIcon, WavingHand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { memo } from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableWithoutFeedback, View } from "react-native";
import { Theme } from "../ui/theme";

interface NativeMeetingActionsSheetProps {
  visible: boolean;
  isMuted: boolean;
  isCameraOff: boolean;
  isScreenSharing: boolean;
  isHandRaised: boolean;
  isRecording: boolean;
  screenShareEnabled: boolean;
  chatEnabled: boolean;
  peopleEnabled: boolean;
  transcriptsEnabled: boolean;
  whiteboardEnabled: boolean;
  recordingEnabled: boolean;
  settingsEnabled: boolean;
  chatUnreadCount: number;
  participantCount: number;
  raisedHandCount: number;
  onClose: () => void;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onToggleScreenShare: () => void;
  onInviteParticipants: () => void;
  onOpenChat: () => void;
  onOpenParticipants: () => void;
  onToggleHand: () => void;
  onOpenReactions: () => void;
  onOpenWhiteboard: () => void;
  onOpenTranscripts: () => void;
  onOpenSettings: () => void;
  onToggleRecording: () => void;
  onLeaveMeeting: () => void;
}

const accent = Theme.colors.primary;
const tileBackground = "#11192a";

function NativeMeetingActionsSheetBase({
  visible,
  isMuted,
  isCameraOff,
  isScreenSharing,
  isHandRaised,
  isRecording,
  screenShareEnabled,
  chatEnabled,
  peopleEnabled,
  transcriptsEnabled,
  whiteboardEnabled,
  recordingEnabled,
  settingsEnabled,
  chatUnreadCount,
  participantCount,
  raisedHandCount,
  onClose,
  onToggleAudio,
  onToggleVideo,
  onToggleScreenShare,
  onInviteParticipants,
  onOpenChat,
  onOpenParticipants,
  onToggleHand,
  onOpenReactions,
  onOpenWhiteboard,
  onOpenTranscripts,
  onOpenSettings,
  onToggleRecording,
  onLeaveMeeting,
}: NativeMeetingActionsSheetProps): React.JSX.Element {
  return (
    <Modal animationType="slide" transparent={true} visible={visible} onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <View style={styles.dragHandle} />

              <View style={styles.grid}>
                <ActionTile
                  active={false}
                  danger={isMuted}
                  icon={isMuted ? MicOff01Icon : Mic01Icon}
                  label={isMuted ? "Unmute" : "Mute"}
                  onPress={onToggleAudio}
                />
                <ActionTile
                  active={false}
                  danger={isCameraOff}
                  icon={isCameraOff ? VideoOffIcon : Video01Icon}
                  label={isCameraOff ? "Start Video" : "Stop Video"}
                  onPress={onToggleVideo}
                />
                <ActionTile
                  active={isScreenSharing}
                  disabled={!screenShareEnabled}
                  icon={ComputerScreenShareIcon}
                  label={isScreenSharing ? "Stop Share" : "Share Screen"}
                  onPress={onToggleScreenShare}
                />
                <ActionTile icon={Link01Icon} label="Invite" onPress={onInviteParticipants} />
                <ActionTile badge={chatUnreadCount > 0 ? formatBadge(chatUnreadCount) : null} disabled={!chatEnabled} icon={Chat01Icon} label="Chat" onPress={onOpenChat} />
                <ActionTile badge={participantCount > 1 ? formatBadge(participantCount) : null} disabled={!peopleEnabled} icon={UserGroupIcon} label="People" onPress={onOpenParticipants} />
                <ActionTile
                  active={isHandRaised}
                  badge={raisedHandCount > 0 ? formatBadge(raisedHandCount) : null}
                  icon={WavingHand01Icon}
                  label="Raise Hand"
                  onPress={onToggleHand}
                />
                <ActionTile icon={SmileIcon} label="Reactions" onPress={onOpenReactions} />
                <ActionTile active={whiteboardEnabled} icon={Presentation01Icon} label="Whiteboard" onPress={onOpenWhiteboard} />
                <ActionTile active={isRecording} disabled={!recordingEnabled} icon={RecordIcon} label="Record" onPress={onToggleRecording} />
                <ActionTile disabled={!transcriptsEnabled} icon={TextFontIcon} label="Transcript" onPress={onOpenTranscripts} />
                <ActionTile disabled={!settingsEnabled} icon={Settings01Icon} label="Settings" onPress={onOpenSettings} />
              </View>

              <Pressable onPress={onLeaveMeeting} style={styles.leaveButton}>
                <HugeiconsIcon color="#ffffff" icon={CallEnd01Icon} size={22} />
                <Text style={styles.leaveText}>Leave Meeting</Text>
              </Pressable>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function ActionTile({
  icon,
  label,
  onPress,
  active = false,
  danger = false,
  disabled = false,
  badge = null,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  badge?: string | null;
}): React.JSX.Element {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.tile, active && styles.tileActive, disabled && styles.tileDisabled]}>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      <HugeiconsIcon color={danger ? dangerColor : active ? "#ffffff" : "#f4f4f5"} icon={icon} size={26} />
      <Text style={[styles.tileText, active && styles.tileTextActive, disabled && styles.tileTextDisabled]}>{label}</Text>
    </Pressable>
  );
}

function formatBadge(value: number): string {
  if (value > 9) {
    return "9+";
  }

  return String(value);
}

const dangerColor = "#ff7b7b";

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.52)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#090f18",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 10,
    paddingHorizontal: 14,
    paddingBottom: 18,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "rgba(255,255,255,0.06)",
  },
  dragHandle: {
    width: 42,
    height: 4,
    borderRadius: 999,
    alignSelf: "center",
    marginBottom: 14,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 10,
  },
  tile: {
    width: "31%",
    minHeight: 86,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: tileBackground,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.04)",
  },
  tileActive: {
    backgroundColor: accent,
    borderColor: "rgba(255,255,255,0.12)",
  },
  tileDisabled: {
    opacity: 0.42,
  },
  tileText: {
    color: "#f4f4f5",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
  tileTextActive: {
    color: "#ffffff",
  },
  tileTextDisabled: {
    color: "#7b8190",
  },
  badge: {
    position: "absolute",
    top: 8,
    right: 8,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "700",
  },
  leaveButton: {
    marginTop: 14,
    height: 52,
    borderRadius: 16,
    backgroundColor: "#ff636b",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  leaveText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
  },
});

export const NativeMeetingActionsSheet = memo(NativeMeetingActionsSheetBase);
