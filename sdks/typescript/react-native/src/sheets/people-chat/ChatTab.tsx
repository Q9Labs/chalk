import type { ChatAttachment } from "@q9labsai/chalk-client";
import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View, type ListRenderItemInfo } from "react-native";
import { FaceAvatar } from "../../avatar/FaceAvatar";
import { useSpaceClient } from "../../context/space-client-context";
import { useChat, useSelf } from "../../hooks/space-hooks";
import { Icon } from "../../icons/Icon";
import { ChalkText } from "../../primitives/ChalkText";
import { useTheme } from "../../theme/theme";
import { fontFamilies } from "../../theme/tokens";
import { FileCard, Thumbnails } from "./attachments";
import { fileKind, groupMessages, messageSummary, type ChatEntry, type MessageGroup } from "./chat-model";
import { Composer } from "./Composer";
import { PhotoViewer, type ViewedPhotos } from "./PhotoViewer";

/**
 * The Chat tab: the call's messages, newest at the bottom, and the composer under them. The list
 * is inverted, so it opens at the newest message and stays there as new ones arrive.
 */
export function ChatTab(): React.JSX.Element {
  const client = useSpaceClient();
  const chat = useChat();
  const self = useSelf();
  const [retried, setRetried] = useState<ReadonlySet<string>>(() => new Set());
  const [viewing, setViewing] = useState<ViewedPhotos | null>(null);
  const groups = useMemo(() => groupMessages(chat.messages, chat.pendingSends, self, retried).slice().reverse(), [chat.messages, chat.pendingSends, retried, self]);

  const retry = useCallback(
    (entry: ChatEntry) => {
      const id = entry.clientMessageId;
      if (!id) return;
      setRetried((previous) => new Set(previous).add(id));
      // The new attempt shows up as its own pending send, failed again if it fails.
      client.chat.send({ text: entry.text, attachments: entry.attachments }).catch(() => undefined);
    },
    [client],
  );
  const loadOlder = useCallback(() => {
    if (!chat.pagination.hasOlder || chat.status !== "ready") return;
    // Older history is a nicety; failing to load it leaves the list as it is.
    client.chat.loadOlder().catch(() => undefined);
  }, [chat.pagination.hasOlder, chat.status, client]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<MessageGroup>) => <GroupRow group={item} onOpenPhotos={setViewing} onRetry={retry} />, [retry]);

  return (
    <>
      {groups.length === 0 ? (
        <View style={styles.empty} testID="chat.empty">
          <ChalkText variant="bodyStrong">No messages yet</ChalkText>
          <ChalkText tone="textMuted" variant="meta">
            Messages are seen by everyone in the call.
          </ChalkText>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={styles.content}
          data={groups}
          initialNumToRender={10}
          inverted
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(group) => group.key}
          maxToRenderPerBatch={10}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.5}
          renderItem={renderItem}
          style={styles.list}
          testID="chat.list"
          windowSize={9}
        />
      )}
      <Composer />
      {viewing ? <PhotoViewer onChange={(index) => setViewing({ ...viewing, index })} onClose={() => setViewing(null)} viewing={viewing} /> : null}
    </>
  );
}

type GroupRowProps = {
  readonly group: MessageGroup;
  readonly onRetry: (entry: ChatEntry) => void;
  readonly onOpenPhotos: (viewing: ViewedPhotos) => void;
};

/** One person's run of messages (`.mg`): their face, name and time once, then each message. Yours sit on the right without a face. */
const GroupRow = memo(function GroupRow({ group, onRetry, onOpenPhotos }: GroupRowProps): React.JSX.Element {
  const { mine } = group;
  return (
    <View style={[styles.group, mine ? styles.groupMine : null]} testID={`chat.group.${group.key}`}>
      {mine ? null : (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <FaceAvatar name={group.displayName} size={28} />
        </View>
      )}
      <View style={[styles.column, mine ? styles.columnMine : null]}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.header}>
          {mine ? null : (
            <ChalkText numberOfLines={1} style={styles.name} variant="label">
              {group.displayName}
            </ChalkText>
          )}
          <ChalkText style={styles.time} tabular tone="textMuted" variant="label">
            {group.time}
          </ChalkText>
        </View>
        {group.entries.map((entry) => (
          <Message entry={entry} from={mine ? "You" : group.displayName} key={entry.key} mine={mine} onOpenPhotos={(photos, index) => onOpenPhotos({ photos, index, from: `${mine ? "You" : group.displayName}, ${group.time}` })} onRetry={onRetry} />
        ))}
      </View>
    </View>
  );
});

type MessageProps = {
  readonly entry: ChatEntry;
  readonly from: string;
  readonly mine: boolean;
  readonly onRetry: (entry: ChatEntry) => void;
  readonly onOpenPhotos: (photos: readonly ChatAttachment[], index: number) => void;
};

function Message({ entry, from, mine, onRetry, onOpenPhotos }: MessageProps): React.JSX.Element {
  const { colors } = useTheme();
  const photos = entry.attachments.filter((attachment) => fileKind(attachment.mimeType) === "image");
  const files = entry.attachments.filter((attachment) => fileKind(attachment.mimeType) !== "image");
  const sent = entry.state === "sent";
  const summary = messageSummary(entry.text, entry.attachments);
  const stateLabel = entry.state === "failed" ? ", couldn't send" : sent ? "" : ", sending";
  return (
    <View style={[styles.message, mine ? styles.messageMine : null]} testID={`chat.message.${entry.key}`}>
      <View accessibilityLabel={`${from}: ${summary}${stateLabel}`} accessible={photos.length === 0 && files.length === 0} style={[styles.body, mine ? styles.messageMine : null, sent ? null : styles.pending]}>
        {entry.text ? (
          <View style={[styles.bubble, { backgroundColor: colors.raised }]}>
            <ChalkText variant="body">{entry.text}</ChalkText>
          </View>
        ) : null}
        {photos.length > 0 ? <Thumbnails disabled={!sent} onOpen={(index) => onOpenPhotos(photos, index)} photos={photos} /> : null}
        {files.map((file) => (
          <FileCard attachment={file} key={file.attachmentId} sent={sent} />
        ))}
      </View>
      {entry.state === "queued" || entry.state === "sending" ? (
        <ChalkText style={styles.status} tone="textMuted" variant="caption">
          Sending…
        </ChalkText>
      ) : null}
      {entry.state === "failed" ? (
        <View style={styles.failed}>
          <Icon color={colors.dangerText} name="alert" size={14} />
          <ChalkText color={colors.dangerText} style={styles.failedText} variant="label">
            Couldn’t send.
          </ChalkText>
          <Pressable accessibilityLabel="Retry sending" accessibilityRole="button" hitSlop={12} onPress={() => onRetry(entry)} testID={`chat.retry.${entry.key}`}>
            <ChalkText style={styles.retry} variant="label">
              Retry
            </ChalkText>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  // `.cbody`: 8 pt around the messages.
  content: { padding: 8 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4, padding: 24 },
  group: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 12, marginHorizontal: 4 },
  groupMine: { flexDirection: "row-reverse" },
  column: { flexShrink: 1, minWidth: 0, maxWidth: 240, alignItems: "flex-start", gap: 3 },
  columnMine: { alignItems: "flex-end" },
  header: { flexDirection: "row", alignItems: "baseline", marginHorizontal: 4, marginBottom: 1 },
  name: { fontFamily: fontFamilies[600], marginRight: 6, flexShrink: 1 },
  time: { fontFamily: fontFamilies[400] },
  message: { maxWidth: "100%", alignItems: "flex-start", gap: 4 },
  messageMine: { alignItems: "flex-end" },
  body: { maxWidth: "100%", alignItems: "flex-start", gap: 4 },
  pending: { opacity: 0.55 },
  bubble: { borderRadius: 18, paddingVertical: 8, paddingHorizontal: 12 },
  status: { fontFamily: fontFamilies[400], marginHorizontal: 6 },
  failed: { flexDirection: "row", alignItems: "center", gap: 4, marginHorizontal: 6 },
  failedText: { fontFamily: fontFamilies[400] },
  // `.lnk`: the text colour, underlined, 2 pt by 4 pt of padding.
  retry: { fontFamily: fontFamilies[600], textDecorationLine: "underline", paddingVertical: 2, paddingHorizontal: 4 },
});
