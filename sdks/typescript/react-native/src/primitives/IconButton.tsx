import { forwardRef, memo } from "react";
import { Pressable, StyleSheet, View, type View as ViewType } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Icon, type IconName } from "../icons/Icon";
import { usePressAnimation } from "../motion/press";
import { useTheme } from "../theme/theme";
import { fixed, type Palette } from "../theme/tokens";
import { ChalkText } from "./ChalkText";

export type IconButtonProps = {
  readonly icon: IconName;
  readonly accessibilityLabel: string;
  readonly onPress?: () => void;
  /** 44 pt by default, 52 pt in the phone dock, 40 pt in the header, 36 pt for a close button. */
  readonly size?: 36 | 40 | 44 | 52;
  /** `raised` for dock buttons, `surface` for header buttons, `danger` for Leave, `ghost` for close buttons (`.x`). */
  readonly tone?: "raised" | "surface" | "danger" | "ghost";
  /** An on state: the button inverts, as `aria-pressed="true"` does in the mockup. */
  readonly selected?: boolean;
  /** Draws the icon in the danger text colour, for a muted microphone or a camera that's off. */
  readonly off?: boolean;
  /** A short name under the button, such as the dock's "Speaker". */
  readonly caption?: string;
  /** The button opens a menu or sheet; reported as expanded while it's open. */
  readonly expanded?: boolean;
  /** Sits directly on the call canvas (dock, header); the light theme rings it with a hairline. */
  readonly onCanvas?: boolean;
  readonly disabled?: boolean;
  readonly testID?: string;
};

/** The mockup's round button (`.rb`): press scale 0.94 over 150 ms, background switches at once. */
export const IconButton = memo(
  forwardRef<ViewType, IconButtonProps>(function IconButton({ icon, accessibilityLabel, onPress, size = 44, tone = "raised", selected = false, off = false, caption, expanded, onCanvas = false, disabled = false, testID }, ref) {
    const { colors, elevation } = useTheme();
    const press = usePressAnimation("round");
    const base = selected ? colors.text : BASE[tone](colors);
    const pressedColor = selected ? colors.text : tone === "danger" ? colors.dangerPressed : colors.pressed;
    const iconColor = selected ? colors.canvas : tone === "danger" ? fixed.onDanger : off ? colors.dangerText : tone === "ghost" ? colors.textMuted : colors.text;
    const ring = onCanvas && elevation.ringOnCanvas && tone !== "danger";
    const { down } = press;
    const background = useAnimatedStyle(() => ({ backgroundColor: down.value ? pressedColor : base }));

    return (
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected, disabled, expanded }}
        disabled={disabled}
        hitSlop={size < 44 ? (44 - size) / 2 : undefined}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        ref={ref}
        testID={testID}
      >
        <Animated.View style={[styles.round, { width: size, height: size, borderRadius: size / 2 }, ring ? { boxShadow: `0px 0px 0px 1px ${colors.line}` } : null, disabled ? styles.disabled : null, background, press.scaleStyle]}>
          <Icon color={iconColor} name={icon} size={tone === "ghost" ? 18 : 20} />
        </Animated.View>
        {caption ? (
          <View pointerEvents="none" style={styles.captionBox}>
            <ChalkText numberOfLines={1} tone="textMuted" variant="caption">
              {caption}
            </ChalkText>
          </View>
        ) : null}
      </Pressable>
    );
  }),
);

const BASE: Readonly<Record<NonNullable<IconButtonProps["tone"]>, (colors: Palette) => string>> = {
  raised: (colors) => colors.raised,
  surface: (colors) => colors.surface,
  danger: (colors) => colors.danger,
  ghost: () => fixed.transparent,
};

const styles = StyleSheet.create({
  round: { alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.45 },
  // `.rl`: absolutely placed so the dock keeps its height; its bottom sits 17 pt below the button.
  captionBox: { position: "absolute", left: -20, right: -20, bottom: -17, alignItems: "center" },
});
