import { useEffect, useRef } from "react";
import { AccessibilityInfo, findNodeHandle, StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useMeasuredRef } from "../frame/measurement";
import { Icon } from "../icons/Icon";
import { ChalkText } from "../primitives/ChalkText";
import { PillButton } from "../primitives/PillButton";
import { useTheme } from "../theme/theme";
import { fontFamilies } from "../theme/tokens";

/** The waiting states that sit over the blurred call (T1, T3 to T6). */
export type LimboState =
  | { readonly kind: "joining"; readonly rejoining: boolean }
  | { readonly kind: "knocking"; readonly onCancel: () => void }
  | { readonly kind: "refused"; readonly onAskAgain: () => void }
  | { readonly kind: "reconnecting"; readonly queuedMessages: number }
  | { readonly kind: "hold" };

export type LimboProps = {
  readonly state: LimboState;
  readonly callName: string;
  /** Shows the recording consent line while joining or knocking. */
  readonly recording: boolean;
};

/** The limbo card (`.lmsg`) centred over the veiled call, with the mockup's copy for each state. */
export function Limbo({ state, callName, recording }: LimboProps): React.JSX.Element {
  const { colors } = useTheme();
  const cardStyle = [styles.card, { backgroundColor: colors.surface, borderColor: colors.line }];
  const cardRef = useMeasuredRef<View>("limbo.card", cardStyle);
  const actionRef = useRef<View>(null);
  const consent = recording && (state.kind === "joining" || state.kind === "knocking") ? <Consent /> : null;
  // The mockup moves focus to the card's button when a state with one appears.
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing native accessibility focus and reduced-motion animation.
  useEffect(() => {
    const node = actionRef.current && findNodeHandle(actionRef.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [state.kind]);

  return (
    <View pointerEvents="box-none" style={styles.limbo} testID="frame.limbo">
      <View accessibilityLiveRegion={state.kind === "refused" ? "assertive" : "polite"} accessibilityRole={state.kind === "refused" ? "alert" : "summary"} ref={cardRef} style={cardStyle} testID="limbo.card">
        {state.kind === "joining" ? (
          <Progress message={`${state.rejoining ? "Rejoining" : "Joining"} ${callName}…`} />
        ) : state.kind === "knocking" ? (
          <>
            <Title>{`Asking to join ${callName}`}</Title>
            <Line>The host will let you in.</Line>
            {consent}
            <View style={styles.action}>
              <PillButton label="Cancel" onPress={state.onCancel} ref={actionRef} testID="limbo.cancel" />
            </View>
          </>
        ) : state.kind === "refused" ? (
          <>
            <Title>The host didn’t let you in</Title>
            <View style={styles.action}>
              <PillButton label="Ask again" onPress={state.onAskAgain} ref={actionRef} testID="limbo.ask-again" variant="primary" />
            </View>
          </>
        ) : state.kind === "reconnecting" ? (
          <>
            <Progress message="Reconnecting…" />
            {state.queuedMessages > 0 ? <Line>{`${state.queuedMessages} message${state.queuedMessages > 1 ? "s" : ""} will send when you’re back`}</Line> : null}
          </>
        ) : (
          <>
            <HoldIcon />
            <Title>Your call is on hold</Title>
            <Line>{`You’re on a phone call. You’ll be back in ${callName} when it ends.`}</Line>
          </>
        )}
        {state.kind === "joining" ? consent : null}
      </View>
    </View>
  );
}

function Title({ children }: { readonly children: string }): React.JSX.Element {
  return (
    <ChalkText accessibilityRole="header" style={styles.center} testID="limbo.title" variant="limboTitle">
      {children}
    </ChalkText>
  );
}

function Line({ children }: { readonly children: string }): React.JSX.Element {
  return (
    <ChalkText style={styles.center} testID="limbo.line" tone="textSoft">
      {children}
    </ChalkText>
  );
}

function Progress({ message }: { readonly message: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Spinner />
      <ChalkText testID="limbo.progress" variant="progress">
        {message}
      </ChalkText>
    </View>
  );
}

/** `.hico`: the earpiece in green on a raised circle. */
function HoldIcon(): React.JSX.Element {
  const { colors } = useTheme();
  const style = [styles.holdIcon, { backgroundColor: colors.raised }];
  const ref = useMeasuredRef<View>("limbo.hold-icon", style);
  return (
    <View ref={ref} style={style} testID="limbo.hold-icon">
      <Icon color={colors.success} name="earpiece" />
    </View>
  );
}

/** `.consent`: everyone who joins a recorded call is told before they're in. */
function Consent(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.consent} testID="limbo.consent">
      <Icon color={colors.dangerText} name="rec" size={14} />
      <ChalkText tone="textMuted" variant="label" style={styles.consentText}>
        This call is recorded. By joining, you agree to be recorded.
      </ChalkText>
    </View>
  );
}

/** `.spin`: an 18 pt ring with a bright quarter, one turn every 0.9 s; still with reduced motion. */
function Spinner(): React.JSX.Element {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing native accessibility focus and reduced-motion animation.
  useEffect(() => {
    if (reduceMotion) return;
    turn.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1);
    return () => cancelAnimation(turn);
  }, [reduceMotion, turn]);
  const style = useAnimatedStyle(() => {
    "worklet";
    return { transform: [{ rotate: `${turn.value * 360}deg` }] };
  });
  return <Animated.View style={[styles.spinner, { borderColor: colors.lineStrong, borderTopColor: reduceMotion ? colors.textMuted : colors.text }, style]} />;
}

const styles = StyleSheet.create({
  limbo: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  card: { alignItems: "center", gap: 8, maxWidth: "100%", paddingVertical: 22, paddingHorizontal: 28, borderWidth: 1, borderRadius: 16, marginHorizontal: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  center: { textAlign: "center" },
  // `.lmsg .pb` adds 10 pt above the button on top of the card's 8 pt gap.
  action: { marginTop: 10 },
  holdIcon: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  consent: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  // `.consent` is 12 pt at the body weight.
  consentText: { fontFamily: fontFamilies[400], flexShrink: 1 },
  spinner: { width: 18, height: 18, borderRadius: 9, borderWidth: 2 },
});
