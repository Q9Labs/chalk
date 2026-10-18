import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, runOnJS, useAnimatedKeyboard, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { useBackHandler } from "../frame/back-handler";
import { useDeviceLayout } from "../frame/device-layout";
import { Portal } from "../frame/portal";
import { useMeasuredRef } from "../frame/measurement";
import { haptics } from "../haptics/haptics";
import { timings } from "../motion/motion";
import { useTheme } from "../theme/theme";
import { durations, easings, fixed, radii } from "../theme/tokens";
import { ChalkText } from "./ChalkText";

export type BottomSheetProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly accessibilityLabel: string;
  readonly children: ReactNode;
  /** A header line under the grabber (`.shd`); it takes accessibility focus when the sheet opens. */
  readonly title?: string;
  /** A fixed height as a share of the screen; People and Chat use 0.78. Without it the sheet fits its content. */
  readonly heightRatio?: number;
  /** Side padding: 12 for menu-like sheets (`.sheet`), 20 for card-like ones (`.ready`). */
  readonly inset?: 12 | 14 | 20;
  /** Where accessibility focus returns when the sheet closes, usually the button that opened it. */
  readonly returnFocusRef?: RefObject<View | null>;
  readonly testID?: string;
};

/** Letting go after dragging the sheet down further than this closes it. */
const CLOSE_DISTANCE = 80;
/** Padding under the content: on top of the safe area when the keyboard is down, alone when it's up. */
const BOTTOM_PADDING = 10;
const KEYBOARD_PADDING = 12;
const FADE = { duration: durations.scrim, easing: easings.easeOut, reduceMotion: ReduceMotion.Never };

type SheetDrag = { readonly drag: SharedValue<number>; readonly close: () => void };
const SheetDragContext = createContext<SheetDrag | null>(null);

/**
 * The phone bottom sheet. It runs to the very bottom edge of the screen with the safe area as
 * padding inside, and only its top corners are rounded. Drag the grabber (or a `SheetDragRegion`)
 * down to close; the sheet follows the finger on the UI thread. It rides above the keyboard,
 * Android back closes the top sheet, and accessibility focus moves in and back out.
 */
export function BottomSheet({ open, onClose, accessibilityLabel, children, title, heightRatio, inset = 12, returnFocusRef, testID }: BottomSheetProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const layout = useDeviceLayout();
  const reduceMotion = useReducedMotion();
  // Expo 55 apps are edge-to-edge on Android, so the keyboard height already counts from the screen edge.
  const keyboard = useAnimatedKeyboard();
  const [mounted, setMounted] = useState(open);
  const height = useSharedValue(0);
  const offset = useSharedValue(layout.height);
  const drag = useSharedValue(0);
  const shown = useSharedValue(0);
  const titleRef = useRef<View>(null);

  useBackHandler(open, onClose);

  const show = useCallback(() => {
    drag.value = 0;
    if (reduceMotion) {
      offset.value = 0;
      shown.value = withTiming(1, FADE);
    } else {
      offset.value = withTiming(0, timings.sheet);
      shown.value = withTiming(1, timings.scrim);
    }
    const node = titleRef.current && findNodeHandle(titleRef.current);
    if (node) setTimeout(() => AccessibilityInfo.setAccessibilityFocus(node), durations.sheet);
  }, [drag, offset, reduceMotion, shown]);

  const hide = useCallback(() => {
    const finish = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(setMounted)(false);
    };
    shown.value = withTiming(0, reduceMotion ? FADE : timings.scrim, reduceMotion ? finish : undefined);
    if (!reduceMotion) offset.value = withTiming(height.value || layout.height, timings.sheet, finish);
  }, [height, layout.height, offset, reduceMotion, shown]);

  const wasOpen = useRef(open);
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (!open) return hide();
    setMounted(true);
    if (height.value > 0) show();
  }, [height, hide, open, show]);

  const wasMounted = useRef(mounted);
  useEffect(() => {
    const closed = wasMounted.current && !mounted;
    wasMounted.current = mounted;
    if (!closed || !returnFocusRef?.current) return;
    const node = findNodeHandle(returnFocusRef.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [mounted, returnFocusRef]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const first = height.value === 0;
      height.value = event.nativeEvent.layout.height;
      if (!first || !open) return;
      offset.value = reduceMotion ? 0 : height.value;
      show();
    },
    [height, offset, open, reduceMotion, show],
  );

  const sheetStyle = useAnimatedStyle(() => {
    "worklet";
    return {
      opacity: reduceMotion ? shown.value : 1,
      paddingBottom: keyboard.height.value > 0 ? KEYBOARD_PADDING : layout.insets.bottom + BOTTOM_PADDING,
      maxHeight: layout.height - layout.insets.top - 8 - keyboard.height.value,
      transform: [{ translateY: offset.value + drag.value - keyboard.height.value }],
    };
  });
  const scrimStyle = useAnimatedStyle(() => {
    "worklet";
    return { opacity: shown.value };
  });

  const width = layout.arrangement === "pad" ? 440 : layout.arrangement === "landscape" ? 460 : layout.width;
  const surfaceStyle = [styles.sheet, { backgroundColor: colors.surface, width, left: (layout.width - width) / 2, paddingHorizontal: inset }, heightRatio ? { height: layout.height * heightRatio } : null];
  const surfaceRef = useMeasuredRef<View>(testID, surfaceStyle);

  if (!mounted) return null;
  return (
    <Portal layer="sheets">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: fixed.scrim }, scrimStyle]}>
        <Pressable accessible={false} onPress={onClose} style={StyleSheet.absoluteFill} testID={testID ? `${testID}.scrim` : undefined} />
      </Animated.View>
      <SheetDragContext.Provider value={{ drag, close: onClose }}>
        <Animated.View accessibilityLabel={accessibilityLabel} accessibilityViewIsModal onAccessibilityEscape={onClose} onLayout={onLayout} ref={surfaceRef} style={[surfaceStyle, sheetStyle]} testID={testID}>
          <SheetDragRegion>
            <View style={styles.grabArea} testID={testID ? `${testID}.grabber` : undefined}>
              <View style={[styles.grabber, { backgroundColor: colors.lineStrong }]} />
            </View>
            {title ? (
              <View accessibilityRole="header" accessible ref={titleRef} style={styles.header}>
                <ChalkText numberOfLines={1} variant="sheetTitle">
                  {title}
                </ChalkText>
              </View>
            ) : null}
          </SheetDragRegion>
          {children}
        </Animated.View>
      </SheetDragContext.Provider>
    </Portal>
  );
}

/** Makes its children a handle that drags the enclosing sheet, like the tab row of People and Chat. */
export function SheetDragRegion({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const sheet = useContext(SheetDragContext);
  if (!sheet) throw new Error("SheetDragRegion must be inside a BottomSheet.");
  const { drag, close } = sheet;
  const gesture = Gesture.Pan()
    .activeOffsetY(4)
    .onUpdate((event) => {
      "worklet";
      const next = Math.max(0, event.translationY);
      if (next > CLOSE_DISTANCE !== drag.value > CLOSE_DISTANCE) runOnJS(haptics.sheetDetent)();
      drag.value = next;
    })
    .onEnd(() => {
      "worklet";
      if (drag.value > CLOSE_DISTANCE) runOnJS(close)();
      else drag.value = withTiming(0, timings.sheet);
    });
  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  sheet: { position: "absolute", bottom: 0, paddingTop: 8, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet },
  grabArea: { alignItems: "center", paddingTop: 4, paddingBottom: 12 },
  grabber: { width: 36, height: 5, borderRadius: 3 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 4, paddingHorizontal: 8, paddingBottom: 14 },
});
