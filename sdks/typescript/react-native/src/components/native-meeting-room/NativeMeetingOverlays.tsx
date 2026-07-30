import type { ChalkAssignableParticipantRole, ChalkReaction } from "@q9labsai/chalk-client";
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { Theme } from "../../ui/theme";
import type { useNativeMeetingRoomController } from "./useNativeMeetingRoomController";

type Controller = ReturnType<typeof useNativeMeetingRoomController>;

export function NativeMeetingActionMenu({ controller }: { readonly controller: Controller }): React.JSX.Element {
  const actions = [
    { label: "Invite participants", enabled: true, onPress: controller.handleInviteParticipants },
    { label: "Participants", enabled: controller.canParticipants, onPress: () => controller.openPanel("participants") },
    { label: "Chat", enabled: controller.canChat, onPress: () => controller.openPanel("chat") },
    {
      label: controller.screenShare.isLocalSharing ? "Stop presenting" : "Present screen",
      enabled: controller.canScreenShare,
      onPress: controller.toggleScreenShare,
    },
    {
      label: controller.handRaised ? "Lower hand" : "Raise hand",
      enabled: controller.canHandRaise,
      onPress: controller.toggleHand,
    },
    {
      label: controller.whiteboard.isOpen ? "Close whiteboard" : "Open whiteboard",
      enabled: controller.canWhiteboard,
      onPress: controller.whiteboard.toggle,
    },
    {
      label: "Reactions",
      enabled: controller.canReactions,
      onPress: () => {
        controller.setActionsOpen(false);
        controller.setReactionPickerOpen(true);
      },
    },
  ];
  return (
    <Modal animationType="slide" onRequestClose={() => controller.setActionsOpen(false)} transparent visible={controller.actionsOpen}>
      <Pressable onPress={() => controller.setActionsOpen(false)} style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Meeting actions</Text>
          {actions.map((action) => (
            <Pressable disabled={!action.enabled} key={action.label} onPress={action.onPress} style={({ pressed }) => [styles.action, !action.enabled && styles.disabled, pressed && styles.pressed]}>
              <Text style={styles.actionText}>{action.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={controller.handleLeave} style={[styles.action, styles.dangerAction]}>
            <Text style={[styles.actionText, styles.dangerText]}>Leave meeting</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

export function NativeMeetingPanel({ controller }: { readonly controller: Controller }): React.JSX.Element {
  return (
    <Modal animationType="slide" onRequestClose={controller.closePanel} presentationStyle="pageSheet" visible={controller.panel !== null}>
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.title}>{controller.panel === "chat" ? "Chat" : "Participants"}</Text>
          <Pressable onPress={controller.closePanel} style={styles.close}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>
        {controller.panel === "chat" ? <ChatPanel controller={controller} /> : <ParticipantsPanel controller={controller} />}
      </View>
    </Modal>
  );
}

function ChatPanel({ controller }: { readonly controller: Controller }): React.JSX.Element {
  return (
    <View style={styles.flex}>
      {controller.chat.hasMore ? (
        <Pressable disabled={controller.chat.isLoadingOlder} onPress={() => void controller.chat.loadOlderMessages()} style={styles.loadOlder}>
          <Text style={styles.secondaryText}>{controller.chat.isLoadingOlder ? "Loading…" : "Load earlier messages"}</Text>
        </Pressable>
      ) : null}
      <FlatList
        contentContainerStyle={styles.list}
        data={controller.chat.messages}
        keyExtractor={(message) => message.id}
        onViewableItemsChanged={({ viewableItems }) => {
          const sequence = viewableItems.at(-1)?.item.sequence;
          if (sequence) controller.markChatMessageVisible(sequence);
        }}
        renderItem={({ item }) => (
          <View style={styles.message}>
            <Text style={styles.itemTitle}>{item.senderName}</Text>
            <Text style={styles.body}>{item.text}</Text>
            {item.attachments.map((attachment) => (
              <Pressable accessibilityRole="link" key={attachment.attachmentId} onPress={() => controller.openChatAttachment(attachment.attachmentId)}>
                <Text style={styles.attachment}>{attachment.fileName}</Text>
              </Pressable>
            ))}
            {item.readBy.length ? <Text style={styles.meta}>Read by {item.readBy.map((reader) => reader.displayName).join(", ")}</Text> : null}
          </View>
        )}
      />
      {controller.chat.pendingMessages.map((message) => (
        <View key={message.clientMessageId} style={styles.pending}>
          <Text style={styles.body}>{message.text}</Text>
          <Text style={styles.meta}>{message.state === "sending" ? "Sending…" : (message.error?.message ?? "Send failed")}</Text>
          {message.state === "failed" ? (
            <Pressable onPress={() => void controller.chat.retryMessage(message.clientMessageId)}>
              <Text style={styles.link}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {controller.chatAttachments.length ? (
        <View style={styles.selectedAttachments}>
          {controller.chatAttachments.map((attachment) => (
            <Pressable accessibilityLabel={`Remove ${attachment.fileName}`} key={attachment.attachmentId} onPress={() => controller.removeChatAttachment(attachment.attachmentId)} style={styles.selectedAttachment}>
              <Text numberOfLines={1} style={styles.attachment}>
                {attachment.fileName} ×
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.composer}>
        {controller.pickChatAttachments ? (
          <Pressable disabled={controller.chatAttachmentsLoading} onPress={controller.pickChatAttachments} style={styles.attach}>
            <Text style={styles.link}>{controller.chatAttachmentsLoading ? "Adding…" : "Attach"}</Text>
          </Pressable>
        ) : null}
        <TextInput multiline onChangeText={controller.setChatDraft} onSubmitEditing={controller.sendChatMessage} placeholder="Message everyone" placeholderTextColor={Theme.colors.placeholder} style={styles.input} value={controller.chatDraft} />
        <Pressable disabled={!controller.chatDraft.trim() && controller.chatAttachments.length === 0} onPress={controller.sendChatMessage} style={styles.send}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ParticipantsPanel({ controller }: { readonly controller: Controller }): React.JSX.Element {
  return (
    <ScrollView contentContainerStyle={styles.list}>
      {controller.admissionRequests.map((request) => (
        <View key={request.admissionRequestId} style={styles.request}>
          <View style={styles.flex}>
            <Text style={styles.itemTitle}>{request.displayName}</Text>
            <Text style={styles.meta}>Waiting to join</Text>
          </View>
          {controller.canManageAdmission ? (
            <>
              <Pressable onPress={() => controller.admitParticipant(request.admissionRequestId)}>
                <Text style={styles.link}>Admit</Text>
              </Pressable>
              <Pressable onPress={() => controller.denyAdmission(request.admissionRequestId)}>
                <Text style={styles.dangerText}>Deny</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ))}
      {controller.participants.participants.map((participant) => {
        const local = participant.id === controller.participants.localParticipant?.id;
        return (
          <View key={participant.id} style={styles.participant}>
            <View style={styles.flex}>
              <Text style={styles.itemTitle}>
                {participant.displayName}
                {local ? " (you)" : ""}
              </Text>
              <Text style={styles.meta}>
                {participant.role} · {participant.audioEnabled ? "mic on" : "muted"} · {participant.videoEnabled ? "camera on" : "camera off"}
              </Text>
            </View>
            {!local && canActOnParticipant(controller) ? (
              <Pressable onPress={() => openParticipantActions(controller, participant.id, participant.role)}>
                <Text style={styles.link}>Manage</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function canActOnParticipant(controller: Controller): boolean {
  return controller.canMuteParticipants || controller.canRequestMedia || controller.canStopParticipantCamera || controller.canStopParticipantScreenShare || controller.canSetParticipantRole || controller.canTransferHost || controller.canRemoveParticipants;
}

function openParticipantActions(controller: Controller, participantSessionId: string, role: "host" | "cohost" | "participant"): void {
  const buttons: { readonly label: string; readonly action: () => void }[] = [];
  if (controller.canMuteParticipants) buttons.push({ label: "Mute", action: () => controller.muteParticipant(participantSessionId) });
  if (controller.canRequestMedia) {
    buttons.push({ label: "Request unmute", action: () => controller.requestUnmuteParticipant(participantSessionId) }, { label: "Request camera", action: () => controller.requestStartParticipantCamera(participantSessionId) });
  }
  if (controller.canStopParticipantCamera) buttons.push({ label: "Stop camera", action: () => controller.stopParticipantCamera(participantSessionId) });
  if (controller.canStopParticipantScreenShare) buttons.push({ label: "Stop presenting", action: () => controller.stopParticipantScreenShare(participantSessionId) });
  if (controller.canSetParticipantRole && role !== "host") {
    const nextRole: ChalkAssignableParticipantRole = role === "cohost" ? "participant" : "cohost";
    buttons.push({ label: nextRole === "cohost" ? "Make cohost" : "Make participant", action: () => controller.setParticipantRole(participantSessionId, nextRole) });
  }
  if (controller.canTransferHost && role !== "host") buttons.push({ label: "Transfer host", action: () => controller.transferHost(participantSessionId) });
  if (controller.canRemoveParticipants) buttons.push({ label: "Remove", action: () => controller.removeParticipant(participantSessionId) });
  // A compact nested modal keeps platform behavior predictable without inventing a second role vocabulary.
  controller.closePanel();
  globalThis.setTimeout(() => {
    Alert.alert("Manage participant", undefined, [...buttons.map((button) => ({ text: button.label, onPress: button.action })), { text: "Cancel", style: "cancel" }]);
  }, 120);
}

export function selectReaction(controller: Controller, reaction: string): void {
  controller.sendReaction(reaction as ChalkReaction);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    gap: 8,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: Theme.colors.background,
    padding: 24,
    paddingBottom: 40,
  },
  panel: { flex: 1, backgroundColor: Theme.colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: Theme.colors.border,
    padding: 20,
  },
  title: { ...Theme.typography.title, color: Theme.colors.foreground },
  close: { padding: 8 },
  closeText: { color: Theme.colors.primary, fontWeight: "700" },
  action: { borderRadius: 14, backgroundColor: Theme.colors.card, padding: 16 },
  actionText: { color: Theme.colors.foreground, fontSize: 16, fontWeight: "600" },
  dangerAction: { marginTop: 8, borderWidth: 1, borderColor: Theme.colors.error },
  dangerText: { color: Theme.colors.error, fontWeight: "700" },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.65 },
  list: { padding: 16, gap: 12 },
  loadOlder: { alignItems: "center", padding: 12 },
  secondaryText: { color: Theme.colors.mutedForeground },
  message: { gap: 4, borderRadius: 14, backgroundColor: Theme.colors.card, padding: 12 },
  pending: { marginHorizontal: 16, marginBottom: 8, gap: 4, borderRadius: 14, borderWidth: 1, borderColor: Theme.colors.border, padding: 12 },
  itemTitle: { color: Theme.colors.foreground, fontWeight: "700" },
  body: { color: Theme.colors.foreground, fontSize: 15 },
  meta: { color: Theme.colors.mutedForeground, fontSize: 12 },
  attachment: { color: Theme.colors.primary, fontSize: 13 },
  link: { color: Theme.colors.primary, fontWeight: "700" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, borderTopWidth: 1, borderTopColor: Theme.colors.border, padding: 12 },
  attach: { paddingHorizontal: 4, paddingVertical: 12 },
  selectedAttachments: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  selectedAttachment: { maxWidth: "100%", borderRadius: 10, backgroundColor: Theme.colors.card, paddingHorizontal: 10, paddingVertical: 7 },
  input: { flex: 1, maxHeight: 120, borderRadius: 16, backgroundColor: Theme.colors.card, color: Theme.colors.foreground, paddingHorizontal: 14, paddingVertical: 10 },
  send: { borderRadius: 14, backgroundColor: Theme.colors.primary, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: Theme.colors.primaryForeground, fontWeight: "800" },
  participant: { flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderBottomColor: Theme.colors.border, paddingVertical: 12 },
  request: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 14, borderWidth: 1, borderColor: Theme.colors.primary, padding: 12 },
});
