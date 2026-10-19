import { Text, type TextProps } from "react-native";
import { useMeasuredRef } from "../frame/measurement";
import { useTheme } from "../theme/theme";
import { type, type Palette, type TypeStyle } from "../theme/tokens";

export type ChalkTextProps = TextProps & {
  readonly variant?: TypeStyle;
  readonly tone?: keyof Palette;
  /** A fixed colour for text on video or on a fixed overlay; wins over `tone`. */
  readonly color?: string;
  /** Tabular figures, so timers and counts don't jitter. */
  readonly tabular?: boolean;
};

/** Figtree text in one of the call's type styles. */
export function ChalkText({ variant = "body", tone = "text", color, tabular = false, style, ...rest }: ChalkTextProps): React.JSX.Element {
  const { colors } = useTheme();
  const textStyle = [type[variant], { color: color ?? colors[tone] }, tabular ? TABULAR : null, style];
  const ref = useMeasuredRef<Text>(rest.testID, textStyle);
  return <Text {...rest} ref={ref} style={textStyle} />;
}

const TABULAR = { fontVariant: ["tabular-nums" as const] };
