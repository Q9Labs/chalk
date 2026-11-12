import { ChalkText, FaceAvatar, fixed, Icon, PillButton, useDeviceLayout, usePressAnimation, useTheme, useToastClearance, useToasts } from "@q9labsai/chalk-react-native/ui";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SpaceRoute } from "../lib/space-link";
import type { StoredCallPreferences } from "../preferences/call-preferences";
import { ClipboardCard, type ClipboardState } from "./ClipboardCard";
import { JoinSheet } from "./JoinSheet";
import type { RecentCall, RecentCalls } from "./recent-calls";
import { RecentCallMenu, type OpenMenu } from "./RecentCallMenu";
import { RecentCallsList } from "./RecentCallsList";
import { YouSheet } from "./YouSheet";
import { space, corners } from "@q9labsai/chalk-react-native";

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
      <RecentCallsList calls={recentCalls.calls} menuLink={menu?.call.link} onJoin={onJoinRecent} onOpenMenu={openMenu} />
      <View onLayout={(event) => setToastBottom(FOOT_BOTTOM + event.nativeEvent.layout.height + TOAST_GAP)} style={styles.foot}>
        {clipboard.offer ? <ClipboardCard offer={clipboard.offer} onDismiss={clipboard.dismiss} onJoin={onJoin} onNotALink={() => toasts.show({ kind: "error", dismissible: true, message: "That isn’t a Chalk call link." })} /> : null}
        <PillButton icon="plus" label="Start a call" onPress={onStartCall} size="big" testID="home.start" variant="primary" />
        <PillButton icon="link" label="Join with a link" onPress={() => setSheet("join")} ref={joinRef} size="big" testID="home.join" />
      </View>
      <YouSheet name={name} onClose={() => setSheet(null)} onSaveName={saveName} open={sheet === "you"} preferences={preferences} returnFocusRef={youRef} />
      <JoinSheet onClose={() => setSheet(null)} onJoin={joinFromSheet} open={sheet === "join"} returnFocusRef={joinRef} />
      <RecentCallMenu fallbackAnchor={youRef} menu={menu} onClose={() => setMenu(null)} onRemove={remove} />
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { height: 56, flexDirection: "row", alignItems: "center" },
  you: { flexDirection: "row", alignItems: "center", gap: space[2], height: 44, paddingLeft: space["1-5"], paddingRight: space[3], marginLeft: -space["1-5"], borderRadius: corners.pill },
  foot: { gap: space["2-5"], paddingTop: space[3] },
});
