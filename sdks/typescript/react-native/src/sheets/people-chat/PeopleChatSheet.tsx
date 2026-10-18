import { useEffect, type RefObject } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSpaceClient } from "../../context/space-client-context";
import { useChat, useParticipants } from "../../hooks/space-hooks";
import { BottomSheet, SheetDragRegion } from "../../primitives/BottomSheet";
import { ChalkText } from "../../primitives/ChalkText";
import { IconButton } from "../../primitives/IconButton";
import { useTheme } from "../../theme/theme";
import { ChatTab } from "./ChatTab";
import { PeopleTab } from "./PeopleTab";

export type PeopleChatTab = "people" | "chat";

export type PeopleChatSheetProps = {
  readonly open: boolean;
  readonly tab: PeopleChatTab;
  readonly onTabChange: (tab: PeopleChatTab) => void;
  readonly onClose: () => void;
  /** Where accessibility focus returns when the sheet closes. */
  readonly returnFocusRef?: RefObject<View | null>;
};

/**
 * People and Chat share one card (`.card`): a 78 % sheet whose tab row switches between who is in
 * the call and the call's chat. The tab row drags the sheet like the grabber does.
 */
export function PeopleChatSheet({ open, tab, onTabChange, onClose, returnFocusRef }: PeopleChatSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const { roster } = useParticipants();
  const chat = useChat();
  useMarkChatRead(open && tab === "chat");
  const unread = chat.unreadCount > 0 && tab !== "chat";
  return (
    <BottomSheet accessibilityLabel="People and chat" heightRatio={0.78} onClose={onClose} open={open} returnFocusRef={returnFocusRef} testID="sheet.people" variant="card">
      <SheetDragRegion>
        <View accessibilityRole="tablist" style={[styles.tabs, { borderBottomColor: colors.line }]}>
          <Tab label="People" count={roster.length} onPress={() => onTabChange("people")} selected={tab === "people"} testID="sheet.tab.people" />
          <Tab label="Chat" onPress={() => onTabChange("chat")} selected={tab === "chat"} testID="sheet.tab.chat" unread={unread} />
          <View style={styles.close}>
            <IconButton accessibilityLabel="Close" icon="x" onPress={onClose} size={44} testID="sheet.people.close" tone="ghost" />
          </View>
        </View>
      </SheetDragRegion>
      {tab === "people" ? <PeopleTab /> : <ChatTab />}
    </BottomSheet>
  );
}

type TabProps = {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly count?: number;
  readonly unread?: boolean;
  readonly testID: string;
};

function Tab({ label, selected, onPress, count, unread = false, testID }: TabProps): React.JSX.Element {
  const { colors } = useTheme();
  const accessibilityLabel = [count === undefined ? label : `${label}, ${count}`, unread ? "new messages" : null].filter(Boolean).join(", ");
  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="tab" accessibilityState={{ selected }} onPress={onPress} style={styles.tab} testID={testID}>
      <View style={styles.tabLabel}>
        <ChalkText tone={selected ? "text" : "textMuted"} variant="bodyStrong">
          {label}
        </ChalkText>
        {count === undefined ? null : (
          <ChalkText style={styles.count} tabular tone="textMuted" variant="bodyMedium">
            {count}
          </ChalkText>
        )}
      </View>
      {selected ? <View style={[styles.underline, { backgroundColor: colors.text }]} /> : null}
      {unread ? <View style={[styles.unread, { backgroundColor: colors.info }]} testID={`${testID}.unread`} /> : null}
    </Pressable>
  );
}

/** While the Chat tab is in view, tells the server you've read up to the newest message. */
function useMarkChatRead(reading: boolean): void {
  const client = useSpaceClient();
  const { messages, unreadCount } = useChat();
  const last = messages[messages.length - 1]?.messageId;
  useEffect(() => {
    if (!reading || !last || unreadCount === 0) return;
    // A lost read receipt only leaves the unread dot up; the next message marks it again.
    client.chat.markRead(last).catch(() => undefined);
  }, [client, last, reading, unreadCount]);
}

const styles = StyleSheet.create({
  // `.tabs`: 4 pt above, 8 right, 10 left, a hairline under it.
  tabs: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 4, paddingRight: 8, paddingLeft: 10, borderBottomWidth: 1 },
  tab: { height: 46, justifyContent: "center", paddingHorizontal: 10 },
  tabLabel: { flexDirection: "row", alignItems: "center" },
  count: { marginLeft: 5 },
  underline: { position: "absolute", left: 10, right: 10, bottom: -1, height: 2, borderRadius: 2 },
  unread: { position: "absolute", right: 0, top: 13, width: 7, height: 7, borderRadius: 4 },
  close: { marginLeft: "auto" },
});
