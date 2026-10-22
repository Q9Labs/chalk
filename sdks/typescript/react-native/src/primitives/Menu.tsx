import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, Keyboard, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useBackHandler } from "../frame/back-handler";
import { useDeviceLayout } from "../frame/device-layout";
import { Portal, useMenuHostRef } from "../frame/portal";
import { useMeasuredRef } from "../frame/measurement";
import { Icon, type IconName } from "../icons/Icon";
import { timings } from "../motion/motion";
import { useTheme } from "../theme/theme";
import { radii, sizes } from "../theme/tokens";
import { ChalkText } from "./ChalkText";
import { normalizeMenuAnchor, placeMenu, type MenuPlacement, type Rect } from "./menu-placement";

export type MenuProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The button that opened the menu. The menu sits next to it and focus returns to it. */
  readonly anchorRef: RefObject<View | null>;
  readonly accessibilityLabel: string;
  readonly children: ReactNode;
  readonly minWidth?: number;
  readonly testID?: string;
};

type MenuFocus = { readonly claim: (node: View) => void };
const MenuFocusContext = createContext<MenuFocus | null>(null);

/**
 * The menu and popover surface (`.pop`): 12 pt radius, sentence-case section labels and
 * 40 pt rows (48 pt on a phone). It opens below its trigger, flips above only when there's
 * more room there, shifts sideways to stay on screen, and stays inside the safe area.
 */
export function Menu({ open, onClose, anchorRef, accessibilityLabel, children, minWidth = 250, testID }: MenuProps): React.JSX.Element | null {
  const { colors, elevation } = useTheme();
  const layout = useDeviceLayout();
  const reduceMotion = useReducedMotion();
  const hostRef = useMenuHostRef();
  const [anchor, setAnchor] = useState<{ readonly trigger: Rect; readonly viewport: Rect } | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const firstItem = useRef<View | null>(null);
  const keyboardHeight = useKeyboardHeight();
  const shown = useSharedValue(0);

  useBackHandler(open, onClose);

  useEffect(() => {
    if (!open) {
      firstItem.current = null;
      setAnchor(null);
      setPlacement(null);
      shown.value = 0;
      return;
    }
    const host = hostRef.current;
    const trigger = anchorRef.current;
    if (!host || !trigger) return;
    // Both native measurements must use the same window origin, including Android system bars.
    host.measureInWindow((x, y, width, height) => {
      const viewport = { x, y, width, height };
      trigger.measureInWindow((x, y, width, height) => setAnchor({ trigger: normalizeMenuAnchor({ x, y, width, height }, viewport), viewport }));
    });
  }, [anchorRef, hostRef, open, shown]);

  // Like iOS menus, an open menu closes when the screen rotates or resizes, because its trigger moved.
  const viewport = `${layout.x},${layout.y}:${layout.width}x${layout.height}`;
  const openedIn = useRef(viewport);
  useEffect(() => {
    if (!open) openedIn.current = viewport;
    else if (viewport !== openedIn.current) onClose();
  }, [onClose, open, viewport]);

  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed || !anchorRef.current) return;
    const node = findNodeHandle(anchorRef.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [anchorRef, open]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!anchor || placement) return;
      const { width, height } = event.nativeEvent.layout;
      setPlacement(placeMenu(anchor.trigger, { width, height }, anchor.viewport, layout.insets, keyboardHeight));
      shown.value = reduceMotion ? 1 : withTiming(1, timings.menu);
    },
    [anchor, keyboardHeight, layout, placement, reduceMotion, shown],
  );

  useEffect(() => {
    if (!placement || !firstItem.current) return;
    const node = findNodeHandle(firstItem.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [placement]);

  const surfaceStyle = useAnimatedStyle(() => {
    "worklet";
    return { opacity: shown.value, transform: [{ translateY: reduceMotion ? 0 : (1 - shown.value) * 4 }] };
  });
  const focus = useMemo<MenuFocus>(
    () => ({
      claim: (node) => {
        firstItem.current ??= node;
      },
    }),
    [],
  );

  const surfaceStatic = [styles.surface, { minWidth, backgroundColor: colors.popover, borderColor: colors.lineStrong, boxShadow: elevation.popover }, placement ? { left: placement.x, top: placement.y, maxHeight: placement.maxHeight ?? undefined } : styles.measuring];
  const surfaceRef = useMeasuredRef<View>(testID, surfaceStatic);

  if (!open || !anchor) return null;
  return (
    <Portal layer="menus">
      <Pressable accessible={false} onPress={onClose} style={StyleSheet.absoluteFill} testID={testID ? `${testID}.backdrop` : undefined} />
      <Animated.View accessibilityLabel={accessibilityLabel} accessibilityRole="menu" accessibilityViewIsModal onAccessibilityEscape={onClose} onLayout={onLayout} ref={surfaceRef} style={[surfaceStatic, surfaceStyle]} testID={testID}>
        <MenuFocusContext.Provider value={focus}>
          <ScrollView bounces={false} scrollEnabled={placement?.maxHeight != null}>
            {children}
          </ScrollView>
        </MenuFocusContext.Provider>
      </Animated.View>
    </Portal>
  );
}

export type MenuItemProps = {
  readonly label: string;
  readonly onPress: () => void;
  readonly icon?: IconName;
  /** A smaller second line under the label (`.mi small`). */
  readonly detail?: string;
  /** Muted text at the end of the row (`.mi .end`). */
  readonly trailing?: string;
  /** Rows in a choice list reserve a check column; `true` draws the check. */
  readonly checked?: boolean;
  readonly danger?: boolean;
  readonly testID?: string;
};

export function MenuItem({ label, onPress, icon, detail, trailing, checked, danger = false, testID }: MenuItemProps): React.JSX.Element {
  const { colors } = useTheme();
  const { phone } = useDeviceLayout();
  const focus = useContext(MenuFocusContext);
  const ref = useRef<View>(null);
  useLayoutEffect(() => {
    if (ref.current) focus?.claim(ref.current);
  }, [focus]);
  const tone = danger ? "dangerText" : "text";
  return (
    <Pressable
      accessibilityLabel={trailing ? `${label}, ${trailing}` : label}
      accessibilityRole="menuitem"
      accessibilityState={checked === undefined ? undefined : { checked }}
      onPress={onPress}
      ref={ref}
      style={({ pressed }) => [styles.item, { minHeight: phone ? sizes.menuRowPhone : sizes.menuRow }, pressed ? { backgroundColor: colors.hover } : null]}
      testID={testID}
    >
      {checked === undefined ? null : <View style={styles.check}>{checked ? <Icon color={colors.text} name="check" size={18} /> : null}</View>}
      {icon ? <Icon color={danger ? colors.dangerText : colors.textMuted} name={icon} size={18} /> : null}
      <View style={styles.labels}>
        <ChalkText numberOfLines={1} tone={tone}>
          {label}
        </ChalkText>
        {detail ? (
          <ChalkText tone="textMuted" variant="label">
            {detail}
          </ChalkText>
        ) : null}
      </View>
      {trailing ? (
        <ChalkText tone="textMuted" variant="meta">
          {trailing}
        </ChalkText>
      ) : null}
    </Pressable>
  );
}

/** A sentence-case label above a group of rows (`.mh2`). */
export function MenuSection({ label }: { readonly label: string }): React.JSX.Element {
  return (
    <View accessibilityRole="header" accessible style={styles.section}>
      <ChalkText tone="textMuted" variant="section">
        {label}
      </ChalkText>
    </View>
  );
}

export function MenuSeparator(): React.JSX.Element {
  const { colors } = useTheme();
  return <View style={[styles.separator, { backgroundColor: colors.line }]} />;
}

function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (event) => setHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

const styles = StyleSheet.create({
  surface: { position: "absolute", padding: 6, borderWidth: 1, borderRadius: radii.menu },
  measuring: { left: 0, top: 0, opacity: 0 },
  item: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, borderRadius: radii.menuRow },
  check: { width: 18, alignItems: "center" },
  labels: { flex: 1, minWidth: 0, gap: 2 },
  section: { paddingTop: 8, paddingHorizontal: 10, paddingBottom: 4 },
  separator: { height: 1, marginVertical: 6, marginHorizontal: 4 },
});
