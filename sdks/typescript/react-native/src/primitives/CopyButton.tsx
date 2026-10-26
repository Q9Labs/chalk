import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Icon } from "../icons/Icon";
import { timings } from "../motion/motion";
import { usePressAnimation } from "../motion/press";
import { useTheme } from "../theme/theme";
import { durations, fixed } from "../theme/tokens";
import { announce } from "./announce";

export type CopyButtonProps = {
  /** Writes the value to the clipboard. The button morphs to a check once it resolves. */
  readonly onCopy: () => void | Promise<void>;
  readonly accessibilityLabel: string;
  /** Spoken once the copy succeeds, for example "Link copied". */
  readonly announcement: string;
  readonly testID?: string;
};

/** The mockup's copy button (`.cp`): the copy icon turns into a green check for two seconds. */
export const CopyButton = memo(function CopyButton({ onCopy, accessibilityLabel, announcement, testID }: CopyButtonProps): React.JSX.Element {
  const { colors } = useTheme();
  const press = usePressAnimation("small");
  const [copied, setCopied] = useState(false);
  const done = useSharedValue(0);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);

  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing native copy animation and feedback timer cleanup.
  useEffect(() => {
    done.value = withTiming(copied ? 1 : 0, timings.copyMorph);
  }, [copied, done]);
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing native copy animation and feedback timer cleanup.
  useEffect(() => () => clearReset(reset), []);

  const copy = useCallback(async () => {
    await onCopy();
    setCopied(true);
    announce(announcement);
    clearReset(reset);
    reset.current = setTimeout(() => setCopied(false), durations.copyReset);
  }, [announcement, onCopy]);

  const copyIconStyle = useAnimatedStyle(() => {
    "worklet";
    return { opacity: 1 - done.value, transform: [{ scale: 1 - 0.6 * done.value }, { rotate: `${20 * done.value}deg` }] };
  });
  const checkIconStyle = useAnimatedStyle(() => {
    "worklet";
    return { opacity: done.value, transform: [{ scale: 0.4 + 0.6 * done.value }, { rotate: `${-20 * (1 - done.value)}deg` }] };
  });
  const { down } = press;
  const pressed = colors.pressed;
  const backgroundStyle = useAnimatedStyle(() => {
    "worklet";
    return { backgroundColor: down.value ? pressed : fixed.transparent };
  });

  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button" hitSlop={4} onPress={copy} onPressIn={press.onPressIn} onPressOut={press.onPressOut} testID={testID}>
      <Animated.View style={[styles.button, backgroundStyle, press.scaleStyle]}>
        <Animated.View style={[styles.icon, copyIconStyle]}>
          <Icon color={colors.text} name="copy" size={18} />
        </Animated.View>
        <Animated.View style={[styles.icon, checkIconStyle]}>
          <Icon color={colors.success} name="check" size={18} />
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
});

function clearReset(reset: { current: ReturnType<typeof setTimeout> | null }): void {
  if (reset.current) clearTimeout(reset.current);
  reset.current = null;
}

const styles = StyleSheet.create({
  button: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  icon: { position: "absolute" },
});
