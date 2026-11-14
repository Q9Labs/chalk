import { ChalkText, FaceAvatar, IconButton, useTheme } from "@q9labsai/chalk-react-native/ui";
import { space, corners } from "@q9labsai/chalk-react-native";
import { memo, useRef, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { formatJoinedAt, type RecentCall } from "./recent-calls";

export type RecentCallsListProps = {
  readonly calls: readonly RecentCall[];
  /** The link of the call whose options menu is open. */
  readonly menuLink: string | undefined;
  readonly onJoin: (call: RecentCall) => void;
  readonly onOpenMenu: (call: RecentCall, anchorRef: RefObject<View | null>) => void;
};

export function RecentCallsList({ calls, menuLink, onJoin, onOpenMenu }: RecentCallsListProps): React.JSX.Element {
  return (
    <ScrollView contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false} style={styles.body}>
      <ChalkText accessibilityRole="header" style={styles.section} tone="textMuted" variant="button">
        Recent calls
      </ChalkText>
      {calls.length > 0 ? (
        calls.map((call) => <RecentCallRow call={call} key={call.link} menuOpen={menuLink === call.link} onJoin={onJoin} onOpenMenu={onOpenMenu} />)
      ) : (
        <ChalkText style={styles.empty} tone="textMuted">
          Calls you join show up here.
        </ChalkText>
      )}
    </ScrollView>
  );
}

type RecentCallRowProps = {
  readonly call: RecentCall;
  readonly menuOpen: boolean;
  readonly onJoin: (call: RecentCall) => void;
  readonly onOpenMenu: (call: RecentCall, anchorRef: RefObject<View | null>) => void;
};

/** `.crow`: join again by tapping the row; the "..." button opens its options. */
const RecentCallRow = memo(function RecentCallRow({ call, menuOpen, onJoin, onOpenMenu }: RecentCallRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const moreRef = useRef<View>(null);
  const when = formatJoinedAt(call.joinedAt);
  const faces = call.people.length > 0 ? call.people.slice(0, 3) : [call.name];
  return (
    <View style={styles.row}>
      <Pressable accessibilityLabel={`Join ${call.name}, ${when}`} accessibilityRole="button" onPress={() => onJoin(call)} style={({ pressed }) => [styles.rowMain, pressed ? { backgroundColor: colors.raised } : null]} testID={`home.recent.${call.link}`}>
        <View style={styles.faces}>
          {faces.map((person, index) => (
            <View key={`${person}-${index}`} style={[styles.face, index > 0 ? styles.faceOverlap : null, { boxShadow: `0px 0px 0px 2px ${colors.canvas}` }]}>
              <FaceAvatar name={person} size={28} />
            </View>
          ))}
        </View>
        <View style={styles.rowText}>
          <ChalkText numberOfLines={1} variant="sheetTitle">
            {call.name}
          </ChalkText>
          <ChalkText tone="textMuted" variant="meta">
            {when}
          </ChalkText>
        </View>
      </Pressable>
      <IconButton accessibilityLabel={`Options for ${call.name}`} expanded={menuOpen} icon="more" onPress={() => onOpenMenu(call, moreRef)} ref={moreRef} size={44} testID="home.recent.more" tone="ghost" />
    </View>
  );
});

const styles = StyleSheet.create({
  body: { flex: 1, marginHorizontal: -space[2] },
  bodyContent: { paddingHorizontal: space[2] },
  section: { paddingTop: space[3], paddingHorizontal: space[1], paddingBottom: space["1-5"] },
  empty: { paddingVertical: space[2], paddingHorizontal: space[1] },
  row: { flexDirection: "row", alignItems: "center", gap: space[1], borderRadius: corners["2xl"] },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space[3], minHeight: 64, paddingHorizontal: space[2], borderRadius: corners["2xl"] },
  faces: { width: 52, flexDirection: "row" },
  face: { width: 28, height: 28, borderRadius: corners.pill },
  faceOverlap: { marginLeft: -space[3] },
  // token-ratchet-ignore: 1px optical nudge between two text lines, below the smallest spacing step
  rowText: { flex: 1, minWidth: 0, gap: 1 },
});
