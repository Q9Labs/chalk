import CallEnd01Icon from "@hugeicons/core-free-icons/dist/esm/CallEnd01Icon";
import Chat01Icon from "@hugeicons/core-free-icons/dist/esm/Chat01Icon";
import ComputerScreenShareIcon from "@hugeicons/core-free-icons/dist/esm/ComputerScreenShareIcon";
import Link01Icon from "@hugeicons/core-free-icons/dist/esm/Link01Icon";
import Presentation01Icon from "@hugeicons/core-free-icons/dist/esm/Presentation01Icon";
import Settings01Icon from "@hugeicons/core-free-icons/dist/esm/Settings01Icon";
import SmileIcon from "@hugeicons/core-free-icons/dist/esm/SmileIcon";
import TextFontIcon from "@hugeicons/core-free-icons/dist/esm/TextFontIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import WavingHand01Icon from "@hugeicons/core-free-icons/dist/esm/WavingHand01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { memo } from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableWithoutFeedback, View } from "react-native";
import { Theme } from "../ui/theme";

export interface NativeMeetingActionsSheetProps {
  visible: boolean;
  isHandRaised: boolean;
  isScreenSharing: boolean;
  chatEnabled: boolean;
  peopleEnabled: boolean;
  transcriptsEnabled: boolean;
  whiteboardEnabled: boolean;
  screenShareEnabled: boolean;
  settingsEnabled: boolean;
  chatUnreadCount: number;
  participantCount: number;
  raisedHandCount: number;
  onClose: () => void;
  onInviteParticipants: () => void;
  onOpenChat: () => void;
  onOpenParticipants: () => void;
  onToggleHand: () => void;
  onOpenReactions: () => void;
  onOpenWhiteboard: () => void;
  onToggleScreenShare: () => void;
  onOpenTranscripts: () => void;
  onOpenSettings: () => void;
  onLeaveMeeting: () => void;
}

const accent = Theme.colors.primary;
const tileBackground = Theme.colors.secondary;

function NativeMeetingActionsSheetIosPadBase({
  visible,
  isHandRaised,
  isScreenSharing,
  chatEnabled,
  peopleEnabled,
  transcriptsEnabled,
  whiteboardEnabled,
  screenShareEnabled,
  settingsEnabled,
  chatUnreadCount,
  participantCount,
  raisedHandCount,
  onClose,
  onInviteParticipants,
  onOpenChat,
  onOpenParticipants,
  onToggleHand,
  onOpenReactions,
  onOpenWhiteboard,
  onToggleScreenShare,
  onOpenTranscripts,
  onOpenSettings,
  onLeaveMeeting,
}: NativeMeetingActionsSheetProps): React.JSX.Element {
  return (
    <Modal animationType="slide" transparent={true} visible={visible} onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <View style={styles.dragHandle} />

              <View style={styles.sectionsContainer}>
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>Communicate</Text>
                  <View style={styles.grid}>
                    <ActionTile icon={Link01Icon} label="Invite" onPress={onInviteParticipants} />
                    <ActionTile badge={chatUnreadCount > 0 ? formatBadge(chatUnreadCount) : null} disabled={!chatEnabled} icon={Chat01Icon} label="Chat" onPress={onOpenChat} />
                    <ActionTile icon={SmileIcon} label="Reactions" onPress={onOpenReactions} />
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>Collaborate</Text>
                  <View style={styles.grid}>
                    <ActionTile active={isHandRaised} badge={raisedHandCount > 0 ? formatBadge(raisedHandCount) : null} icon={WavingHand01Icon} label="Raise Hand" onPress={onToggleHand} />
                    <ActionTile disabled={!whiteboardEnabled} icon={Presentation01Icon} label="Whiteboard" onPress={onOpenWhiteboard} />
                    <ActionTile active={isScreenSharing} disabled={!screenShareEnabled} icon={ComputerScreenShareIcon} label="Share Screen" onPress={onToggleScreenShare} />
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>Meeting</Text>
                  <View style={styles.grid}>
                    <ActionTile disabled={!transcriptsEnabled} icon={TextFontIcon} label="Transcript" onPress={onOpenTranscripts} />
                    <ActionTile badge={participantCount > 1 ? formatBadge(participantCount) : null} disabled={!peopleEnabled} icon={UserGroupIcon} label="People" onPress={onOpenParticipants} />
                    <ActionTile disabled={!settingsEnabled} icon={Settings01Icon} label="Settings" onPress={onOpenSettings} />
                  </View>
                </View>
              </View>

              <Pressable onPress={onLeaveMeeting} style={({ pressed }) => [styles.leaveButton, pressed && { opacity: 0.8, transform: [{ scale: 0.98 }] }]}>
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

function ActionTile({ icon, label, onPress, active = false, disabled = false, badge = null }: { icon: any; label: string; onPress: () => void; active?: boolean; disabled?: boolean; badge?: string | null }): React.JSX.Element {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.tile, active && styles.tileActive, disabled && styles.tileDisabled, pressed && styles.tilePressed]}>
      {badge ? (
        <View style={[styles.badge, active && styles.badgeActive]}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      <HugeiconsIcon color={active ? "#ffffff" : "#e4e4e7"} icon={icon} size={24} />
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#0c0c0e",
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
  sectionsContainer: {
    gap: 16,
  },
  section: {
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: Theme.colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 1,
    paddingHorizontal: 4,
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
    borderColor: "rgba(255,255,255,0.06)",
  },
  tileActive: {
    backgroundColor: accent,
    borderColor: "rgba(255,255,255,0.12)",
  },
  tileDisabled: {
    opacity: 0.42,
  },
  tilePressed: {
    opacity: 0.7,
    transform: [{ scale: 0.95 }],
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
  badgeActive: {
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  badgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "700",
  },
  leaveButton: {
    marginTop: 16,
    height: 50,
    borderRadius: 14,
    backgroundColor: "#ef4444",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  leaveText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
});

export const NativeMeetingActionsSheetIosPad = memo(NativeMeetingActionsSheetIosPadBase);
