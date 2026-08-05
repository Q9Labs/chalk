import Message01Icon from "@hugeicons/core-free-icons/dist/esm/Message01Icon";
import Navigation03Icon from "@hugeicons/core-free-icons/dist/esm/Navigation03Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useMemo } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Theme } from "../../ui/theme";
import { formatChatTimestamp } from "./space-progressive-surface-helpers";
import { InitialsAvatar } from "./SpaceSurfacePrimitives";
import type { SpaceController } from "./space-progressive-surface-types";

export function SpaceChatSheet({ controller }: { readonly controller: SpaceController }): React.JSX.Element {
  const localParticipantId = controller.participants.localParticipant?.id ?? null;
  const sendDisabled = (!controller.chatDraft.trim() && controller.chatAttachments.length === 0) || controller.chatAttachmentUploading;
  const messages = useMemo(() => controller.chat.messages, [controller.chat.messages]);

  return (
    <View style={styles.content}>
      {controller.chat.hasMore ? (
        <Pressable accessibilityRole="button" disabled={controller.chat.isLoadingOlder} onPress={() => void controller.chat.loadOlderMessages()} style={({ pressed }) => [styles.loadOlder, pressed && styles.pressed]}>
          <Text style={styles.loadOlderText}>{controller.chat.isLoadingOlder ? "Loading…" : "Load earlier messages"}</Text>
        </Pressable>
      ) : null}
      <FlatList
        accessibilityLabel="Chat messages"
        contentContainerStyle={styles.messageList}
        data={messages}
        keyExtractor={(message) => message.id}
        ListEmptyComponent={<EmptyChat />}
        onViewableItemsChanged={({ viewableItems }) => {
          const sequence = viewableItems.at(-1)?.item.sequence;
          if (sequence) controller.markChatMessageVisible(sequence);
        }}
        renderItem={({ item }) => <ChatMessage isLocal={item.senderId === localParticipantId} message={item} onOpenAttachment={controller.openChatAttachment} />}
        showsVerticalScrollIndicator={false}
      />
      {controller.chat.pendingMessages.map((message) => (
        <View key={message.clientMessageId} style={styles.pendingMessage}>
          <Text style={styles.pendingText}>{message.text}</Text>
          <Text style={styles.pendingMeta}>{message.state === "sending" ? "Sending…" : (message.error?.message ?? "Send failed")}</Text>
          {message.state === "failed" ? (
            <Pressable accessibilityRole="button" onPress={() => void controller.chat.retryMessage(message.clientMessageId)}>
              <Text style={styles.retry}>Retry</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {controller.chatAttachments.length ? (
        <View accessibilityLabel="Selected attachments" style={styles.selectedAttachments}>
          {controller.chatAttachments.map((attachment, index) => (
            <View key={`${attachment.fileName}-${index}`} style={styles.selectedAttachment}>
              <Text numberOfLines={1} style={styles.selectedAttachmentText}>
                {attachment.fileName}
              </Text>
              <Pressable accessibilityLabel={`Remove ${attachment.fileName}`} accessibilityRole="button" disabled={controller.chatAttachmentUploading} onPress={() => controller.removeChatAttachment(index)}>
                <Text style={styles.removeAttachment}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {controller.chatAttachmentError ? (
        <Text accessibilityLiveRegion="polite" style={styles.attachmentError}>
          {controller.chatAttachmentError}
        </Text>
      ) : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}>
        <View style={styles.composer}>
          {controller.canPickChatFiles ? (
            <Pressable
              accessibilityLabel="Attach file"
              accessibilityRole="button"
              disabled={controller.chatAttachmentPicking || controller.chatAttachmentUploading}
              onPress={() => void controller.pickChatFiles()}
              style={({ pressed }) => [styles.composerButton, (controller.chatAttachmentPicking || controller.chatAttachmentUploading) && styles.sendDisabled, pressed && styles.pressed]}
            >
              <Text style={styles.composerButtonText}>{controller.chatAttachmentPicking ? "Choosing…" : "Attach"}</Text>
            </Pressable>
          ) : null}
          <TextInput
            accessibilityLabel="Message the Space"
            editable={!controller.chatAttachmentUploading}
            multiline
            onChangeText={controller.setChatDraft}
            onSubmitEditing={controller.sendChatMessage}
            placeholder="Message the Space"
            placeholderTextColor={Theme.colors.placeholder}
            style={styles.input}
            value={controller.chatDraft}
          />
          <Pressable accessibilityLabel="Send message" accessibilityRole="button" disabled={sendDisabled} onPress={controller.sendChatMessage} style={({ pressed }) => [styles.sendButton, sendDisabled && styles.sendDisabled, pressed && styles.pressed]}>
            {controller.chatAttachmentUploading ? <Text style={styles.uploadingText}>…</Text> : <HugeiconsIcon color={Theme.colors.primaryForeground} icon={Navigation03Icon} size={21} />}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function ChatMessage({ isLocal, message, onOpenAttachment }: { readonly isLocal: boolean; readonly message: SpaceController["chat"]["messages"][number]; readonly onOpenAttachment: (attachmentId: string) => void }): React.JSX.Element {
  const timestamp = formatChatTimestamp(message.timestamp);
  return (
    <View style={[styles.messageRow, isLocal && styles.messageRowLocal]}>
      {!isLocal ? <InitialsAvatar name={message.senderName} size={42} /> : null}
      <View style={[styles.messageCopy, isLocal && styles.messageCopyLocal]}>
        <Text style={[styles.sender, isLocal && styles.senderLocal]}>{isLocal ? `${message.senderName} (You)` : message.senderName}</Text>
        <View style={[styles.bubble, isLocal ? styles.localBubble : styles.remoteBubble]}>
          {message.text ? <Text style={[styles.messageText, isLocal && styles.localMessageText]}>{message.text}</Text> : null}
          {message.attachments.map((attachment) => (
            <Pressable accessibilityRole="link" key={attachment.attachmentId} onPress={() => onOpenAttachment(attachment.attachmentId)} style={({ pressed }) => [styles.attachmentLink, pressed && styles.pressed]}>
              <Text numberOfLines={1} style={[styles.attachment, isLocal && styles.localMessageText]}>
                {attachment.fileName}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.timestamp, isLocal && styles.timestampLocal]}>{timestamp}</Text>
        {message.readBy.length ? <Text style={[styles.readBy, isLocal && styles.timestampLocal]}>Read by {message.readBy.map((reader) => reader.displayName).join(", ")}</Text> : null}
      </View>
      {isLocal ? <InitialsAvatar name={message.senderName} size={42} /> : null}
    </View>
  );
}

function EmptyChat(): React.JSX.Element {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <HugeiconsIcon color={Theme.colors.ink2} icon={Message01Icon} size={26} />
      </View>
      <Text style={styles.emptyTitle}>No messages yet</Text>
      <Text style={styles.emptyText}>Send a message to start the conversation.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, minHeight: 0 },
  loadOlder: { alignSelf: "center", minHeight: 44, paddingHorizontal: Theme.spacing.md, paddingVertical: Theme.spacing.sm, justifyContent: "center" },
  loadOlderText: { color: Theme.colors.information, fontSize: 14, fontWeight: "700" },
  messageList: { flexGrow: 1, gap: Theme.spacing.lg, paddingHorizontal: Theme.spacing.lg, paddingVertical: Theme.spacing.lg },
  messageRow: { alignItems: "flex-start", flexDirection: "row", gap: Theme.spacing.sm, maxWidth: "92%" },
  messageRowLocal: { alignSelf: "flex-end", justifyContent: "flex-end" },
  messageCopy: { flexShrink: 1, minWidth: 0 },
  messageCopyLocal: { alignItems: "flex-end" },
  sender: { color: Theme.colors.ink, fontSize: 15, fontWeight: "600", marginBottom: 6, paddingHorizontal: 4 },
  senderLocal: { textAlign: "right" },
  bubble: { borderRadius: Theme.radius.md, borderWidth: 1, maxWidth: "100%", paddingHorizontal: Theme.spacing.md, paddingVertical: Theme.spacing.md },
  remoteBubble: { backgroundColor: Theme.colors.surfaceMuted, borderColor: Theme.colors.line, borderTopLeftRadius: 5 },
  localBubble: { backgroundColor: Theme.colors.ink, borderColor: Theme.colors.ink, borderTopRightRadius: 5 },
  messageText: { color: Theme.colors.ink, fontSize: 17, lineHeight: 24 },
  localMessageText: { color: Theme.colors.surface },
  attachmentLink: { justifyContent: "center", marginTop: 4, maxWidth: "100%", minHeight: 32 },
  attachment: { color: Theme.colors.information, fontSize: 14 },
  timestamp: { color: Theme.colors.ink3, fontSize: 12, marginTop: 5, paddingHorizontal: 4 },
  timestampLocal: { textAlign: "right" },
  readBy: { color: Theme.colors.ink3, fontSize: 11, marginTop: 3, paddingHorizontal: 4 },
  pendingMessage: { borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, marginHorizontal: Theme.spacing.lg, marginBottom: Theme.spacing.sm, padding: Theme.spacing.md },
  pendingText: { color: Theme.colors.ink, fontSize: 14 },
  pendingMeta: { color: Theme.colors.ink2, fontSize: 12, marginTop: 4 },
  retry: { color: Theme.colors.information, fontSize: 13, fontWeight: "700", marginTop: 6 },
  selectedAttachments: { flexDirection: "row", flexWrap: "wrap", gap: Theme.spacing.sm, paddingHorizontal: Theme.spacing.lg, paddingBottom: Theme.spacing.sm },
  selectedAttachment: { backgroundColor: Theme.colors.paper2, borderColor: Theme.colors.line, borderRadius: Theme.radius.sm, borderWidth: 1, maxWidth: "100%", minHeight: 36, paddingHorizontal: Theme.spacing.sm, paddingVertical: 8 },
  selectedAttachmentText: { color: Theme.colors.ink2, fontSize: 13 },
  removeAttachment: { color: Theme.colors.information, fontSize: 12, fontWeight: "700", marginTop: 4 },
  attachmentError: { color: Theme.colors.danger, fontSize: 13, paddingHorizontal: Theme.spacing.lg, paddingBottom: Theme.spacing.sm },
  composer: { alignItems: "flex-end", borderTopColor: Theme.colors.line, borderTopWidth: 1, flexDirection: "row", gap: Theme.spacing.sm, padding: Theme.spacing.md },
  composerButton: { alignItems: "center", borderColor: Theme.colors.line, borderRadius: Theme.radius.md, borderWidth: 1, height: 50, justifyContent: "center", width: 50 },
  composerButtonText: { color: Theme.colors.ink2, fontSize: 12, fontWeight: "700" },
  uploadingText: { color: Theme.colors.primaryForeground, fontSize: 18, fontWeight: "700" },
  input: { backgroundColor: Theme.colors.surfaceMuted, borderColor: Theme.colors.lineStrong, borderRadius: Theme.radius.md, borderWidth: 1, color: Theme.colors.ink, flex: 1, fontSize: 16, maxHeight: 112, minHeight: 50, paddingHorizontal: Theme.spacing.md, paddingVertical: 12 },
  sendButton: { alignItems: "center", backgroundColor: Theme.colors.ink, borderRadius: Theme.radius.full, height: 50, justifyContent: "center", width: 50 },
  sendDisabled: { backgroundColor: Theme.colors.lineStrong },
  emptyState: { alignItems: "center", flex: 1, justifyContent: "center", minHeight: 220, paddingHorizontal: Theme.spacing["3xl"] },
  emptyIcon: { alignItems: "center", backgroundColor: Theme.colors.washBlue, borderRadius: Theme.radius.full, height: 58, justifyContent: "center", marginBottom: Theme.spacing.md, width: 58 },
  emptyTitle: { color: Theme.colors.ink, fontSize: 16, fontWeight: "700" },
  emptyText: { color: Theme.colors.ink2, fontSize: 14, marginTop: 6, textAlign: "center" },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
});
