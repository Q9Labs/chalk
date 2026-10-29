import { forwardRef, memo, useEffect, useRef } from "react";
import { formatSyncConnectDiagnostic, getConnectionFailureDetail, type ClientFailure } from "@q9labsai/chalk-client";
import { AccessibilityInfo, findNodeHandle, Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useMeasuredRef } from "../frame/measurement";
import { Icon, type IconName } from "../icons/Icon";
import { usePressAnimation } from "../motion/press";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";
import { fontFamilies } from "../theme/tokens";

/** The ways a call ends for you (A3 to A7). */
export type CallOutcome = "left" | "ended" | "failed" | "removed" | "exited" | "full";

export type StatusPageProps = {
  readonly outcome: CallOutcome;
  readonly callName: string;
  readonly failure?: ClientFailure | null;
  readonly onRejoin: () => void;
  readonly onHome: () => void;
};

type Action = "rejoin" | "home";

type Page = { readonly title: string; readonly detail?: string; readonly actions: readonly Action[]; readonly rejoinLabel?: string };

/** The mockup's copy for each outcome (`SP` in renderLimbo). */
function pageFor(outcome: CallOutcome, callName: string): Page {
  switch (outcome) {
    case "left":
      return { title: `You left ${callName}`, actions: ["rejoin", "home"] };
    case "ended":
      return { title: "The call ended", actions: ["rejoin", "home"] };
    case "failed":
      return { title: `Couldn’t connect to ${callName}`, actions: ["rejoin", "home"], rejoinLabel: "Try again" };
    case "removed":
      return { title: `You were removed from ${callName}`, detail: "The host removed you from this call.", actions: ["home"] };
    case "exited":
      return { title: `You’re no longer in ${callName}`, actions: ["rejoin", "home"] };
    case "full":
      return { title: "This call is full", detail: `${callName} has reached 100 people. Ask the host to make room, then try again.`, actions: ["rejoin", "home"], rejoinLabel: "Try again" };
  }
}

/**
 * A full-screen status page on the canvas (`.status`): a title, an optional line saying what to do,
 * and the ways forward as round actions with their names under them.
 */
export function StatusPage({ outcome, callName, failure, onRejoin, onHome }: StatusPageProps): React.JSX.Element {
  const { colors } = useTheme();
  const page = pageFor(outcome, callName);
  const detail = outcome === "failed" ? getConnectionFailureDetail({ code: failure?.code, sync: failure?.sync }) : page.detail;
  const pageStyle = [styles.page, { backgroundColor: colors.canvas }];
  const ref = useMeasuredRef<View>("status.page", pageStyle);
  const firstAction = useRef<View>(null);
  // The mockup moves focus to the first action when the page appears.
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing native status-page accessibility focus.
  useEffect(() => {
    const node = firstAction.current && findNodeHandle(firstAction.current);
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [outcome]);
  return (
    <View accessibilityViewIsModal ref={ref} style={pageStyle} testID="status.page">
      <ChalkText accessibilityRole="header" style={styles.center} testID="status.title" variant="statusTitle">
        {page.title}
      </ChalkText>
      {detail ? (
        <ChalkText style={styles.center} testID="status.detail" tone="textMuted">
          {detail}
        </ChalkText>
      ) : null}
      {outcome === "failed" && failure ? (
        <ChalkText style={styles.center} testID="status.reference" tone="textMuted" variant="caption">
          {`Reference: ${failure.code}${failure.sync ? ` ${formatSyncConnectDiagnostic(failure.sync)}` : ""}`}
        </ChalkText>
      ) : null}
      <View style={styles.actions}>
        {page.actions.map((action, index) =>
          action === "rejoin" ? (
            <StatusAction icon="retry" key={action} label={page.rejoinLabel ?? "Rejoin"} onPress={onRejoin} ref={index === 0 ? firstAction : undefined} testID="status.rejoin" />
          ) : (
            <StatusAction icon="home" key={action} label="Home" onPress={onHome} ref={index === 0 ? firstAction : undefined} testID="status.home" />
          ),
        )}
      </View>
    </View>
  );
}

type StatusActionProps = {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly testID: string;
};

/** `.act`: a 56 pt round button with its name under it; the round part presses like `.rb`. */
const StatusAction = memo(
  forwardRef<View, StatusActionProps>(function StatusAction({ icon, label, onPress, testID }, ref) {
    const { colors } = useTheme();
    const press = usePressAnimation("round");
    const { down } = press;
    const roundStyle = [styles.round, { backgroundColor: colors.raised }];
    const roundRef = useMeasuredRef<View>(`${testID}.button`, roundStyle);
    const raised = colors.raised;
    const pressed = colors.pressed;
    const background = useAnimatedStyle(() => {
      "worklet";
      return { backgroundColor: down.value ? pressed : raised };
    });
    return (
      <Pressable accessibilityLabel={label} accessibilityRole="button" onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut} ref={ref} style={styles.action} testID={testID}>
        <Animated.View ref={roundRef} style={[roundStyle, background, press.scaleStyle]}>
          <Icon color={colors.text} name={icon} />
        </Animated.View>
        <ChalkText style={styles.actionLabel} testID={`${testID}.label`} tone="textSoft" variant="meta">
          {label}
        </ChalkText>
      </Pressable>
    );
  }),
);

const styles = StyleSheet.create({
  page: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  center: { textAlign: "center" },
  actions: { flexDirection: "row", gap: 28, marginTop: 20 },
  action: { alignItems: "center", gap: 8 },
  round: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  // `.act` is 13 pt at weight 500; the type scale has 13 pt only at 400 and 600.
  actionLabel: { fontFamily: fontFamilies[500] },
});
