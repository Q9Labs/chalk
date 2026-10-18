import { forwardRef, memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type View as ViewType } from "react-native";
import { useConnection } from "../hooks/space-hooks";
import { Icon } from "../icons/Icon";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import type { Arrangement } from "../frame/regions";

export type HeaderProps = {
  readonly callName: string;
  readonly arrangement: Arrangement;
  readonly onOpenDetails: () => void;
};

/**
 * The call header region (owned by the dock and chrome lane). This minimal version shows the
 * call's name, which opens the call details, and the timer.
 */
export const Header = memo(
  forwardRef<ViewType, HeaderProps>(function Header({ callName, arrangement, onOpenDetails }, ref) {
    const { colors } = useTheme();
    const landscape = arrangement === "landscape";
    return (
      <View style={[styles.header, arrangement === "pad" ? styles.pad : landscape ? styles.landscape : styles.portrait]} testID="chalk-header">
        <Pressable accessibilityLabel={`Call details, ${callName}`} accessibilityRole="button" onPress={onOpenDetails} ref={ref} style={[styles.name, landscape ? { backgroundColor: colors.raised, boxShadow: `0px 0px 0px 1px ${colors.lineStrong}` } : null]} testID="chalk-header-name">
          <ChalkText numberOfLines={1} variant="bodyStrong">
            {callName}
          </ChalkText>
          <Icon color={colors.textMuted} name="down" size={16} />
        </Pressable>
        {landscape ? null : <CallTimer />}
      </View>
    );
  }),
);

/** Minutes and seconds since the call started, in tabular figures. Re-renders once a second, alone. */
function CallTimer(): React.JSX.Element | null {
  const { episode } = useConnection();
  const startedAt = episode?.startedAt ? Date.parse(episode.startedAt) : null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === null) return null;
  return (
    <ChalkText accessibilityLabel={`Call time ${formatElapsed(now - startedAt)}`} tabular testID="chalk-header-timer" tone="textMuted" variant="bodyMedium">
      {formatElapsed(now - startedAt)}
    </ChalkText>
  );
}

export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

const styles = StyleSheet.create({
  header: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  portrait: { paddingLeft: 14, paddingRight: 12 },
  landscape: { paddingHorizontal: 8, justifyContent: "flex-start" },
  pad: { paddingLeft: 24, paddingRight: 16 },
  // `.nameb`: 44 pt high, pulled 6 pt left so the text lines up with the header padding.
  name: { flexDirection: "row", alignItems: "center", gap: 4, height: 44, paddingHorizontal: 6, marginLeft: -6, borderRadius: 999, flexShrink: 1 },
});
