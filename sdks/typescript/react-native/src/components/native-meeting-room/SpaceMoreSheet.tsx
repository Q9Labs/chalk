import Chat01Icon from "@hugeicons/core-free-icons/dist/esm/Chat01Icon";
import CallEnd01Icon from "@hugeicons/core-free-icons/dist/esm/CallEnd01Icon";
import ComputerScreenShareIcon from "@hugeicons/core-free-icons/dist/esm/ComputerScreenShareIcon";
import Message01Icon from "@hugeicons/core-free-icons/dist/esm/Message01Icon";
import Navigation03Icon from "@hugeicons/core-free-icons/dist/esm/Navigation03Icon";
import Presentation01Icon from "@hugeicons/core-free-icons/dist/esm/Presentation01Icon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import WavingHand01Icon from "@hugeicons/core-free-icons/dist/esm/WavingHand01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Theme } from "../../ui/theme";
import { IconTile, SheetGrip, type SpaceIcon } from "./SpaceSurfacePrimitives";
import type { SpaceController } from "./space-progressive-surface-types";

interface MoreAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: SpaceIcon;
  readonly symbol?: string;
  readonly wash?: string;
  readonly onPress: () => void;
}

export function SpaceMoreSheet({ controller, onOpenSettings }: { readonly controller: SpaceController; readonly onOpenSettings: () => void }): React.JSX.Element {
  const close = () => controller.setActionsOpen(false);
  const actions: MoreAction[] = [
    {
      id: "share",
      label: "Share",
      icon: Navigation03Icon,
      onPress: () => {
        close();
        controller.handleInviteParticipants();
      },
    },
    ...(controller.canWhiteboard
      ? [
          {
            id: "board",
            label: controller.whiteboard.isOpen ? "Close Board" : "Board",
            icon: Presentation01Icon,
            wash: Theme.colors.washBlue,
            onPress: () => {
              close();
              controller.whiteboard.toggle();
            },
          },
        ]
      : []),
    ...(controller.canHandRaise
      ? [
          {
            id: "hand",
            label: controller.handRaised ? "Lower hand" : "Raise hand",
            icon: WavingHand01Icon,
            wash: controller.handRaised ? Theme.colors.washYellow : undefined,
            onPress: () => {
              close();
              controller.toggleHand();
            },
          },
        ]
      : []),
    ...(controller.canReactions
      ? [
          {
            id: "reactions",
            label: "Reactions",
            icon: Message01Icon,
            onPress: () => {
              close();
              controller.setReactionPickerOpen(true);
            },
          },
        ]
      : []),
    ...(controller.canParticipants ? [{ id: "people", label: "People", icon: UserGroupIcon, onPress: () => controller.openPanel("participants") }] : []),
    ...(controller.canChat ? [{ id: "chat", label: "Chat", icon: Chat01Icon, onPress: () => controller.openPanel("chat") }] : []),
    ...(controller.canScreenShare
      ? [
          {
            id: "screen-share",
            label: controller.screenShare.isLocalSharing ? "Stop sharing" : "Present screen",
            icon: ComputerScreenShareIcon,
            onPress: () => {
              close();
              controller.toggleScreenShare();
            },
          },
        ]
      : []),
    {
      id: "settings",
      label: "Settings",
      symbol: "⚙",
      onPress: () => {
        close();
        onOpenSettings();
      },
    },
  ];

  return (
    <Modal animationType="slide" onRequestClose={close} transparent visible={controller.actionsOpen}>
      <View style={styles.modalRoot}>
        <Pressable accessibilityLabel="Close More" onPress={close} style={styles.backdrop} />
        <View style={styles.sheet}>
          <SheetGrip />
          <Text style={styles.title}>More</Text>
          <ScrollView contentContainerStyle={styles.actionGrid} showsVerticalScrollIndicator={false}>
            {actions.map((action) => (
              <Pressable accessibilityLabel={action.label} accessibilityRole="button" key={action.id} onPress={action.onPress} style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}>
                <IconTile icon={action.icon} symbol={action.symbol} wash={action.wash ?? Theme.colors.surfaceMuted} />
                <Text numberOfLines={2} style={styles.actionLabel}>
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              close();
              controller.handleLeave();
            }}
            style={({ pressed }) => [styles.leaveButton, pressed && styles.actionPressed]}
          >
            <HugeiconsIcon color={Theme.colors.error} icon={CallEnd01Icon} size={20} />
            <Text style={styles.leaveText}>Leave</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(12,14,18,0.22)" },
  sheet: {
    backgroundColor: Theme.colors.surface,
    borderColor: Theme.colors.line,
    borderTopLeftRadius: Theme.radius.xl,
    borderTopRightRadius: Theme.radius.xl,
    elevation: 8,
    maxHeight: "78%",
    paddingBottom: Platform.OS === "ios" ? Theme.spacing["2xl"] : Theme.spacing.lg,
    shadowColor: Theme.colors.ink,
    shadowOffset: { height: -8, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 22,
  },
  title: { ...Theme.typography.heading, color: Theme.colors.ink, paddingHorizontal: Theme.spacing.lg, paddingTop: Theme.spacing.lg },
  actionGrid: { flexDirection: "row", flexWrap: "wrap", gap: Theme.spacing.md, padding: Theme.spacing.lg, paddingBottom: Theme.spacing.md },
  action: { alignItems: "center", backgroundColor: Theme.colors.surfaceMuted, borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, flexDirection: "row", gap: Theme.spacing.md, minHeight: 76, paddingHorizontal: Theme.spacing.md, width: "47.8%" },
  actionLabel: { color: Theme.colors.ink, flex: 1, fontSize: 15, fontWeight: "600", lineHeight: 20 },
  actionPressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
  leaveButton: { alignItems: "center", borderColor: Theme.colors.dangerBackground, borderRadius: Theme.radius.md, borderWidth: 1, flexDirection: "row", gap: Theme.spacing.sm, justifyContent: "center", marginHorizontal: Theme.spacing.lg, minHeight: 52, paddingHorizontal: Theme.spacing.lg },
  leaveText: { color: Theme.colors.error, fontSize: 16, fontWeight: "700" },
});
