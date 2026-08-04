import type { NativeChatMessage as ChatMessage } from "../ui/native-types";
import { useCallback, useRef } from "react";
import { type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, StyleSheet, Text, type StyleProp, View, type ViewStyle } from "react-native";
import { Theme } from "../ui/theme";
import { formatChatAttachmentSize, isLatestChatMessageVisible, type NativeChatViewport } from "./native-chat";

export interface ChatMessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly localParticipantId: string | null;
  readonly onLatestMessageVisible: (sequence: string) => void;
  readonly style?: StyleProp<ViewStyle>;
  readonly contentContainerStyle?: StyleProp<ViewStyle>;
}

export function ChatMessageList({ messages, localParticipantId, onLatestMessageVisible, style, contentContainerStyle }: ChatMessageListProps): React.JSX.Element {
  const latestSequence = messages.at(-1)?.sequence ?? null;
  const viewport = useRef<NativeChatViewport>({ contentHeight: 0, viewportHeight: 0, scrollOffset: 0 });
  const renderedSequence = useRef<string | null>(null);
  const measuredSequence = useRef<string | null>(null);
  const reportedSequence = useRef<string | null>(null);

  if (renderedSequence.current !== latestSequence) {
    renderedSequence.current = latestSequence;
    measuredSequence.current = null;
  }

  const reportLatestIfVisible = useCallback(() => {
    if (!latestSequence || measuredSequence.current !== latestSequence || reportedSequence.current === latestSequence) return;
    if (!isLatestChatMessageVisible(viewport.current)) return;
    reportedSequence.current = latestSequence;
    onLatestMessageVisible(latestSequence);
  }, [latestSequence, onLatestMessageVisible]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewport.current = { ...viewport.current, viewportHeight: event.nativeEvent.layout.height };
      reportLatestIfVisible();
    },
    [reportLatestIfVisible],
  );

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      viewport.current = { ...viewport.current, contentHeight: height };
      measuredSequence.current = latestSequence;
      reportLatestIfVisible();
    },
    [latestSequence, reportLatestIfVisible],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      viewport.current = {
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
        scrollOffset: contentOffset.y,
      };
      measuredSequence.current = latestSequence;
      reportLatestIfVisible();
    },
    [latestSequence, reportLatestIfVisible],
  );

  return (
    <ScrollView accessibilityLabel="Chat messages" contentContainerStyle={[styles.content, contentContainerStyle]} onContentSizeChange={handleContentSizeChange} onLayout={handleLayout} onScroll={handleScroll} scrollEventThrottle={16} showsVerticalScrollIndicator={false} style={style}>
      {messages.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No messages yet.</Text>
          <Text style={styles.emptyText}>Send a message to start the conversation.</Text>
        </View>
      ) : null}
      {messages.map((message) => {
        const isLocal = message.senderId === localParticipantId;
        const readByNames = message.readBy.map((receipt) => receipt.displayName);
        const status = readByNames.length > 0 ? `Read by ${readByNames.join(", ")}` : "Sent";

        return (
          <View key={message.id} style={[styles.messageGroup, isLocal && styles.localMessageGroup]}>
            {!isLocal ? <Text style={styles.sender}>{message.senderName}</Text> : null}
            <View style={[styles.bubble, isLocal ? styles.localBubble : styles.remoteBubble]}>
              {message.content ? <Text style={styles.messageText}>{message.content}</Text> : null}
              {message.attachments.map((attachment) => {
                const isImage = attachment.mimeType.startsWith("image/");
                return (
                  <View accessibilityLabel={`${isImage ? "Image" : "File"} attachment ${attachment.fileName}, ${formatChatAttachmentSize(attachment.byteLength)}`} key={attachment.attachmentId} style={styles.attachment}>
                    <Text style={styles.attachmentKind}>{isImage ? "IMAGE" : "FILE"}</Text>
                    <View style={styles.attachmentMetadata}>
                      <Text numberOfLines={1} style={styles.attachmentName}>
                        {attachment.fileName}
                      </Text>
                      <Text style={styles.attachmentDetails}>
                        {formatChatAttachmentSize(attachment.byteLength)} · {attachment.mimeType}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
            {isLocal ? (
              <Text accessibilityLabel={status} numberOfLines={1} style={[styles.status, readByNames.length > 0 && styles.readStatus]}>
                {status}
              </Text>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 12,
  },
  emptyState: {
    flex: 1,
    minHeight: 160,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: Theme.colors.onDark,
    fontSize: 15,
    fontWeight: "700",
  },
  emptyText: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    marginTop: 6,
    textAlign: "center",
  },
  messageGroup: {
    alignSelf: "flex-start",
    gap: 5,
    maxWidth: "85%",
  },
  localMessageGroup: {
    alignSelf: "flex-end",
    alignItems: "flex-end",
  },
  sender: {
    color: Theme.colors.mutedForeground,
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 4,
  },
  bubble: {
    borderRadius: 18,
    maxWidth: "100%",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  localBubble: {
    backgroundColor: Theme.colors.primary,
    borderBottomRightRadius: 6,
  },
  remoteBubble: {
    backgroundColor: Theme.colors.whiteOverlay06,
    borderBottomLeftRadius: 6,
  },
  messageText: {
    color: Theme.colors.onDark,
    fontSize: 14,
    lineHeight: 20,
  },
  attachment: {
    alignItems: "center",
    backgroundColor: Theme.colors.darkOverlay16,
    borderColor: Theme.colors.whiteOverlay16,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
    minWidth: 190,
    padding: 10,
  },
  attachmentKind: {
    color: Theme.colors.whiteOverlay72,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  attachmentMetadata: {
    flex: 1,
    minWidth: 0,
  },
  attachmentName: {
    color: Theme.colors.onDark,
    fontSize: 13,
    fontWeight: "700",
  },
  attachmentDetails: {
    color: Theme.colors.whiteOverlay68,
    fontSize: 10,
    marginTop: 2,
  },
  status: {
    color: Theme.colors.mutedForeground,
    fontSize: 10,
    maxWidth: 240,
    paddingHorizontal: 4,
  },
  readStatus: {
    color: Theme.colors.primary,
  },
});
