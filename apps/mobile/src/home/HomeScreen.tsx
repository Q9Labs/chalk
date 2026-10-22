import { announce, ChalkText, FaceAvatar, fixed, Icon, IconButton, Menu, MenuItem, PillButton, useDeviceLayout, usePressAnimation, useTheme, useToastClearance, useToasts } from "@q9labsai/chalk-react-native/ui";
import { setStringAsync } from "expo-clipboard";
import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { shareLink } from "../lib/share";
import type { SpaceRoute } from "../lib/spaces";
import type { StoredCallPreferences } from "../preferences/call-preferences";
import { ClipboardCard, type ClipboardState } from "./ClipboardCard";
import { JoinSheet } from "./JoinSheet";
import { formatJoinedAt, type RecentCall, type RecentCalls } from "./recent-calls";
import { YouSheet } from "./YouSheet";

type HomeScreenProps = {
  readonly name: string | null;
  readonly onSaveName: (name: string) => void;
  readonly preferences: StoredCallPreferences;
  readonly recentCalls: RecentCalls;
  readonly onStartCall: () => void;
  readonly onJoin: (route: SpaceRoute) => void;
  readonly onJoinRecent: (call: RecentCall) => void;
  /** From `useClipboardOffer`, which runs only while Home shows. */
  readonly clipboard: ClipboardState;
};

type OpenSheet = "you" | "join" | null;
type OpenMenu = { readonly call: RecentCall; readonly anchorRef: RefObject<View | null> };

/** The root's bottom padding under the foot, and the gap a notice keeps above the foot's top edge. */
const FOOT_BOTTOM = 12;
const TOAST_GAP = 8;

/** A1 with H1: you, recent calls, then Start a call and Join with a link at the bottom. */
export function HomeScreen({ name, onSaveName, preferences, recentCalls, onStartCall, onJoin, onJoinRecent, clipboard }: HomeScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const layout = useDeviceLayout();
  const toasts = useToasts();
  const setToastBottom = useToastClearance();
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const youRef = useRef<View>(null);
  const joinRef = useRef<View>(null);
  const insets = useSafeAreaInsets();
  // iPad keeps the phone layout in a 440 pt column.
  const side = layout.phone ? 16 : Math.max(16, layout.width / 2 - 220);

  useEffect(() => () => setToastBottom(null), [setToastBottom]);

  const saveName = (next: string) => {
    onSaveName(next);
    setSheet(null);
    toasts.show({ leading: <Icon color={colors.textMuted} name="check" />, message: ["Saved. You’ll join calls as ", { strong: next }] });
  };
  const joinFromSheet = (route: SpaceRoute) => {
    setSheet(null);
    onJoin(route);
  };
  const remove = (call: RecentCall) => {
    setMenu(null);
    const undo = recentCalls.remove(call.link);
    const id = toasts.show({
      leading: <Icon color={colors.textMuted} name="trash" />,
      message: ["Removed ", { strong: call.name }, " from recent calls"],
      actions: [
        {
          label: "Undo",
          testID: "home.recent.undo",
          onPress: () => {
            undo();
            toasts.dismiss(id);
          },
        },
      ],
    });
  };
  const openMenu = useCallback((call: RecentCall, anchorRef: RefObject<View | null>) => setMenu({ call, anchorRef }), []);

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas, paddingTop: insets.top + 4, paddingBottom: insets.bottom + FOOT_BOTTOM, paddingLeft: side + insets.left, paddingRight: side + insets.right }]} testID="home.screen">
      <View style={styles.top}>
        <YouButton name={name} onPress={() => setSheet("you")} pressableRef={youRef} />
      </View>
      <ScrollView contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false} style={styles.body}>
        <ChalkText accessibilityRole="header" style={styles.section} tone="textMuted" variant="button">
          Recent calls
        </ChalkText>
        {recentCalls.calls.length > 0 ? (
          recentCalls.calls.map((call) => <RecentCallRow call={call} key={call.link} menuOpen={menu?.call.link === call.link} onJoin={onJoinRecent} onOpenMenu={openMenu} />)
        ) : (
          <ChalkText style={styles.empty} tone="textMuted">
            Calls you join show up here.
          </ChalkText>
        )}
      </ScrollView>
      <View onLayout={(event) => setToastBottom(FOOT_BOTTOM + event.nativeEvent.layout.height + TOAST_GAP)} style={styles.foot}>
        {clipboard.offer ? <ClipboardCard offer={clipboard.offer} onDismiss={clipboard.dismiss} onJoin={onJoin} onNotALink={() => toasts.show({ kind: "error", dismissible: true, message: "That isn’t a Chalk call link." })} /> : null}
        <PillButton icon="plus" label="Start a call" onPress={onStartCall} size="big" testID="home.start" variant="primary" />
        <PillButton icon="link" label="Join with a link" onPress={() => setSheet("join")} ref={joinRef} size="big" testID="home.join" />
      </View>
      <YouSheet name={name} onClose={() => setSheet(null)} onSaveName={saveName} open={sheet === "you"} preferences={preferences} returnFocusRef={youRef} />
      <JoinSheet onClose={() => setSheet(null)} onJoin={joinFromSheet} open={sheet === "join"} returnFocusRef={joinRef} />
      <Menu accessibilityLabel="Call options" anchorRef={menu?.anchorRef ?? youRef} onClose={() => setMenu(null)} open={menu !== null} testID="menu.recent">
        {menu ? (
          <>
            <MenuItem
              icon="copy"
              label="Copy link"
              onPress={() => {
                setMenu(null);
                void setStringAsync(menu.call.link).then(() => announce("Link copied"));
              }}
              testID="menu.recent.copy"
            />
            <MenuItem
              icon="iosShare"
              label="Share link"
              onPress={() => {
                setMenu(null);
                shareLink(menu.call.link);
              }}
              testID="menu.recent.share"
            />
            <MenuItem danger icon="trash" label="Remove from recent calls" onPress={() => remove(menu.call)} testID="menu.recent.remove" />
          </>
        ) : null}
      </Menu>
    </View>
  );
}

/** `.meb`: your face and name; opens "Your name and appearance". */
function YouButton({ name, onPress, pressableRef }: { readonly name: string | null; readonly onPress: () => void; readonly pressableRef: RefObject<View | null> }): React.JSX.Element {
  const { colors } = useTheme();
  const press = usePressAnimation("pill");
  const { down } = press;
  const pressed = colors.raised;
  const background = useAnimatedStyle(() => {
    "worklet";
    return { backgroundColor: down.value ? pressed : fixed.transparent };
  });
  const label = name ?? "Add your name";
  return (
    <Pressable accessibilityLabel={`${label}. Change your name and appearance`} accessibilityRole="button" onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} ref={pressableRef} testID="home.you">
      <Animated.View style={[styles.you, background, press.scaleStyle]}>
        <FaceAvatar name={name ?? "You"} size={32} />
        <ChalkText numberOfLines={1} variant="sheetTitle">
          {label}
        </ChalkText>
        <Icon color={colors.textMuted} name="down" size={16} />
      </Animated.View>
    </Pressable>
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
  root: { flex: 1 },
  top: { height: 56, flexDirection: "row", alignItems: "center" },
  you: { flexDirection: "row", alignItems: "center", gap: 8, height: 44, paddingLeft: 6, paddingRight: 12, marginLeft: -6, borderRadius: 999 },
  body: { flex: 1, marginHorizontal: -8 },
  bodyContent: { paddingHorizontal: 8 },
  section: { paddingTop: 14, paddingHorizontal: 4, paddingBottom: 6 },
  empty: { paddingVertical: 8, paddingHorizontal: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 16 },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingHorizontal: 8, borderRadius: 16 },
  faces: { width: 52, flexDirection: "row" },
  face: { width: 28, height: 28, borderRadius: 14 },
  faceOverlap: { marginLeft: -12 },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  foot: { gap: 10, paddingTop: 12 },
});
