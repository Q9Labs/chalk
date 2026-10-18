import { forwardRef, memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type View as ViewType } from "react-native";
import Animated from "react-native-reanimated";
import { useConnection, useRecording } from "../hooks/space-hooks";
import { useMeasuredRef } from "../frame/measurement";
import { Icon } from "../icons/Icon";
import { usePressAnimation } from "../motion/press";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import type { Arrangement } from "../frame/regions";

export type HeaderProps = {
  readonly callName: string;
  readonly arrangement: Arrangement;
  readonly onOpenDetails: () => void;
  /** The call details sheet is open. */
  readonly detailsOpen: boolean;
};

/**
 * The call header (`.hdr`): the call's name with its chevron, which opens the call details, then
 * the Rec dot while the call is recorded (K5) and the timer. In landscape the name sits in a
 * pill and the timer is left out.
 */
export const Header = memo(
  forwardRef<ViewType, HeaderProps>(function Header({ callName, arrangement, onOpenDetails, detailsOpen }, ref) {
    const { colors } = useTheme();
    const press = usePressAnimation("pill");
    const landscape = arrangement === "landscape";
    const headerStyle = [styles.header, arrangement === "pad" ? styles.pad : landscape ? styles.landscape : styles.portrait];
    const headerRef = useMeasuredRef<ViewType>("frame.header", headerStyle);
    const nameStyle = [styles.name, landscape ? [styles.namePill, { backgroundColor: colors.raised, boxShadow: `0px 0px 0px 1px ${colors.lineStrong}` }] : null];
    const nameRef = useMeasuredRef<ViewType>("header.name", nameStyle);
    return (
      <View pointerEvents="box-none" ref={headerRef} style={headerStyle} testID="frame.header">
        <Pressable accessibilityLabel={`Call details, ${callName}`} accessibilityRole="button" accessibilityState={{ expanded: detailsOpen }} onPress={onOpenDetails} onPressIn={press.onPressIn} onPressOut={press.onPressOut} ref={ref} style={styles.nameButton} testID="header.name">
          <Animated.View ref={nameRef} style={[nameStyle, press.scaleStyle]}>
            <ChalkText numberOfLines={1} style={styles.nameText} variant="bodyStrong">
              {callName}
            </ChalkText>
            <Icon color={colors.textMuted} name="down" size={16} />
          </Animated.View>
        </Pressable>
        <View style={styles.status}>
          <RecordingDot />
          {landscape ? null : <CallTimer />}
        </View>
      </View>
    );
  }),
);

/** `.rec`: a red dot and "Rec" while the call is being recorded, seen by everyone in it. */
function RecordingDot(): React.JSX.Element | null {
  const { colors } = useTheme();
  const status = useRecording().current?.status;
  if (status !== "recording" && status !== "stopping") return null;
  return (
    <View accessibilityLabel="This call is being recorded" accessible style={styles.rec} testID="header.recording">
      <View style={[styles.recDot, { backgroundColor: colors.danger }]} />
      <ChalkText variant="meta">Rec</ChalkText>
    </View>
  );
}

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
    <ChalkText accessibilityLabel={`Call time ${formatElapsed(now - startedAt)}`} tabular testID="header.timer" tone="textMuted" variant="bodyMedium">
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
  header: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  portrait: { paddingLeft: 14, paddingRight: 12 },
  landscape: { paddingHorizontal: 8, justifyContent: "flex-start" },
  pad: { paddingLeft: 24, paddingRight: 16 },
  nameButton: { flexShrink: 1 },
  // `.nameb`: 44 pt high, pulled 6 pt left so the text lines up with the header padding.
  name: { flexDirection: "row", alignItems: "center", gap: 4, height: 44, paddingHorizontal: 6, marginLeft: -6, borderRadius: 999 },
  // `.lnd .title`: a 40 pt pill. The mockup pulls `.nameb` 6 pt into the pill's 2 pt padding, so the
  // text starts 2 pt in, and the name's own 6 pt plus the pill's 12 pt follow the chevron.
  namePill: { height: 40, marginLeft: 0, paddingLeft: 2, paddingRight: 18 },
  nameText: { flexShrink: 1 },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  rec: { flexDirection: "row", alignItems: "center", gap: 6 },
  recDot: { width: 8, height: 8, borderRadius: 4 },
});
