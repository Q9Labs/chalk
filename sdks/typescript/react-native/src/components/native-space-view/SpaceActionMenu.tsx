import type { Reaction } from "@q9labsai/chalk-client";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { Theme } from "../../ui/theme";
import { useNativeTheme } from "../../ui/native-theme";
import type { useSpaceViewController } from "./useSpaceViewController";

type Controller = ReturnType<typeof useSpaceViewController>;

export function SpaceActionMenu({ controller }: { readonly controller: Controller }): React.JSX.Element {
  const theme = useNativeTheme();
  const actions = [
    ...(controller.canInvite ? [{ label: "Invite participants", onPress: controller.handleInviteParticipants }] : []),
    ...(controller.canParticipants ? [{ label: "Participants", onPress: () => controller.openPanel("participants") }] : []),
    ...(controller.canChat ? [{ label: "Chat", onPress: () => controller.openPanel("chat") }] : []),
    ...(controller.canScreenShare ? [{ label: controller.screenShare.isLocalSharing ? "Stop presenting" : "Present screen", onPress: controller.toggleScreenShare }] : []),
    ...(controller.canHandRaise ? [{ label: controller.handRaised ? "Lower hand" : "Raise hand", onPress: controller.toggleHand }] : []),
    ...(controller.canWhiteboard ? [{ label: controller.whiteboard.isOpen ? "Close whiteboard" : "Open whiteboard", onPress: controller.whiteboard.toggle }] : []),
    ...(controller.canReactions
      ? [
          {
            label: "Reactions",
            onPress: () => {
              controller.setActionsOpen(false);
              controller.setReactionPickerOpen(true);
            },
          },
        ]
      : []),
    ...(controller.canSettings ? [{ label: "Settings", onPress: () => controller.openPanel("settings") }] : []),
    ...(["grid", "focus", "presentation"] as const).map((layout) => ({
      label: `${layout === "grid" ? "Grid" : layout === "focus" ? "Focus" : "Presentation"} layout${controller.layout.layout === layout ? " (selected)" : ""}`,
      onPress: () => {
        controller.layout.setLayout(layout);
        controller.setActionsOpen(false);
      },
    })),
  ];
  return (
    <Modal animationType="slide" onRequestClose={() => controller.setActionsOpen(false)} transparent visible={controller.actionsOpen}>
      <Pressable onPress={() => controller.setActionsOpen(false)} style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: theme.colors.background }]}>
          <Text style={[styles.title, { color: theme.colors.foreground }]}>Space actions</Text>
          {actions.map((action) => (
            <Pressable key={action.label} onPress={action.onPress} style={({ pressed }) => [styles.action, { backgroundColor: theme.colors.card }, pressed && styles.pressed]}>
              <Text style={[styles.actionText, { color: theme.colors.foreground }]}>{action.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={controller.handleLeave} style={[styles.action, styles.dangerAction, { backgroundColor: theme.colors.card, borderColor: theme.colors.error }]}>
            <Text style={[styles.actionText, styles.dangerText, { color: theme.colors.error }]}>Leave space</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

export function selectSpaceReaction(controller: Controller, reaction: string): void {
  controller.sendReaction(reaction as Reaction);
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: Theme.colors.darkOverlay55 },
  sheet: {
    gap: 8,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: Theme.colors.background,
    padding: 24,
    paddingBottom: 40,
  },
  title: { ...Theme.typography.title, color: Theme.colors.foreground },
  action: { borderRadius: 14, backgroundColor: Theme.colors.card, padding: 16 },
  actionText: { color: Theme.colors.foreground, fontSize: 16, fontWeight: "600" },
  dangerAction: { marginTop: 8, borderWidth: 1, borderColor: Theme.colors.error },
  dangerText: { color: Theme.colors.error, fontWeight: "700" },
  pressed: { opacity: 0.65 },
});
