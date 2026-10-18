import { forwardRef, memo } from "react";
import { Pressable, StyleSheet, type View as ViewType } from "react-native";
import Animated from "react-native-reanimated";
import { Icon, type IconName } from "../icons/Icon";
import { usePressAnimation } from "../motion/press";
import { useTheme } from "../theme/theme";
import { fixed, type TypeStyle } from "../theme/tokens";
import { ChalkText } from "./ChalkText";

export type PillButtonProps = {
  readonly label: string;
  readonly onPress?: () => void;
  readonly variant?: "primary" | "secondary" | "danger";
  /**
   * `sm` 32, `md` 36 (`.pb`), `lg` 40, `wide` 48 and full width (sheets), `big` 52 and full width (Home).
   * Home's inline buttons: `inline` 40 (`.clipc .pb`), `card` 44 and full width (`.lcard .pb`), `field` 48 beside a field (`.yrow .pb`).
   */
  readonly size?: "sm" | "md" | "lg" | "wide" | "big" | "inline" | "card" | "field";
  readonly icon?: IconName;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly testID?: string;
};

const HEIGHT = { sm: 32, md: 36, lg: 40, wide: 48, big: 52, inline: 40, card: 44, field: 48 } as const;
const PADDING = { sm: 12, md: 14, lg: 14, wide: 14, big: 14, inline: 12, card: 14, field: 18 } as const;
const TEXT: Readonly<Record<keyof typeof HEIGHT, TypeStyle>> = { sm: "button", md: "button", lg: "bodyStrong", wide: "wideButton", big: "sheetTitle", inline: "button", card: "button", field: "button" };
const ICON = { sm: 18, md: 18, lg: 18, wide: 18, big: 20, inline: 18, card: 18, field: 18 } as const;

/** The mockup's pill button (`.pb`, `.big`): primary inverts, secondary is raised, danger is red. */
export const PillButton = memo(
  forwardRef<ViewType, PillButtonProps>(function PillButton({ label, onPress, variant = "secondary", size = "md", icon, accessibilityLabel, disabled = false, testID }, ref) {
    const { colors } = useTheme();
    const press = usePressAnimation(size === "big" ? "big" : "pill");
    const background = variant === "primary" ? colors.text : variant === "danger" ? colors.danger : size === "big" ? colors.raised : colors.hover;
    const foreground = variant === "primary" ? colors.canvas : variant === "danger" ? fixed.onDanger : colors.text;
    const full = size === "wide" || size === "big" || size === "card";

    return (
      <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} ref={ref} style={full ? styles.full : null} testID={testID}>
        <Animated.View style={[styles.pill, { height: HEIGHT[size], paddingHorizontal: PADDING[size], backgroundColor: background }, disabled ? styles.disabled : null, press.scaleStyle]}>
          {icon ? <Icon color={foreground} name={icon} size={ICON[size]} /> : null}
          <ChalkText color={foreground} numberOfLines={1} variant={TEXT[size]}>
            {label}
          </ChalkText>
        </Animated.View>
      </Pressable>
    );
  }),
);

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 999 },
  full: { alignSelf: "stretch" },
  disabled: { opacity: 0.4 },
});
