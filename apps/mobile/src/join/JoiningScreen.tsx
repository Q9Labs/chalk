import { ChalkArrival } from "@q9labsai/chalk-react-native";
import { Limbo, useTheme, type ColorScheme } from "@q9labsai/chalk-react-native/ui";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { cleanupSpaceArrival, createPublicSpaceRoute, prepareSpaceArrival, waitForAdmission, type MobileSpaceArrival, type SpaceArrivalStep, type SpaceRoute, type StoredSpaceArrival } from "../lib/spaces";

/** Where a join is headed: a new call, or a call someone shared. */
export type JoinTarget = { readonly kind: "start" } | { readonly kind: "link"; readonly route: SpaceRoute };

export type ArrivedCall = {
  readonly route: SpaceRoute;
  readonly arrival: MobileSpaceArrival;
  /** True when this person just started the call, so the app offers its link. */
  readonly started: boolean;
};

type JoiningScreenProps = {
  readonly apiBaseURL: string;
  readonly target: JoinTarget;
  readonly displayName: string;
  readonly colorScheme: ColorScheme;
  readonly onArrived: (call: ArrivedCall) => void;
  readonly onFailed: (cause: unknown) => void;
  /** The person stopped waiting: Cancel while knocking, Home on a full call, or Android back. */
  readonly onCancel: () => void;
};

type Waiting = Exclude<SpaceArrivalStep, { readonly state: "admitted" }>;

function joiningName(target: JoinTarget, displayName: string): string {
  if (target.kind === "link") return target.route.spaceName ?? target.route.space;
  return `${displayName.split(/\s+/u)[0]}’s call`;
}

/**
 * T1: the call's limbo while the app gets access, then T3 knocking, T4 refused or A7 full while
 * the call doesn't let the person in yet. `Chalk` shows the same limbo while it connects, so the
 * hand-over is seamless. Leaving before access arrives gives the arrival back.
 */
export function JoiningScreen({ apiBaseURL, target, displayName, colorScheme, onArrived, onFailed, onCancel }: JoiningScreenProps): React.JSX.Element {
  const callbacks = useRef({ onArrived, onFailed });
  callbacks.current = { onArrived, onFailed };
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  // Ask again and Try again start a new arrival.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let knocking: StoredSpaceArrival | undefined;
    const release = (credential: StoredSpaceArrival) => void cleanupSpaceArrival({ apiBaseURL, credential }).catch(() => undefined);
    const fail = (cause: unknown) => {
      if (active) callbacks.current.onFailed(cause);
    };
    const settle = (step: SpaceArrivalStep, route: SpaceRoute, started: boolean) => {
      if (!active) {
        if (step.state === "admitted") release(step.arrival.credential);
        else if (step.state === "knocking") release(step.credential);
        return;
      }
      if (step.state === "admitted") {
        knocking = undefined;
        callbacks.current.onArrived({ route, arrival: step.arrival, started });
        return;
      }
      setWaiting(step);
      knocking = step.state === "knocking" ? step.credential : undefined;
      if (step.state !== "knocking") return;
      timer = setTimeout(() => {
        waitForAdmission({ apiBaseURL, route, displayName, credential: step.credential }).then((next) => settle(next, route, started), fail);
      }, step.retryAfterMs);
    };

    if (target.kind === "start") createPublicSpaceRoute({ apiBaseURL, displayName }).then(({ arrival, route }) => settle({ state: "admitted", arrival }, route, true), fail);
    else prepareSpaceArrival({ apiBaseURL, displayName, route: target.route }).then((step) => settle(step, target.route, false), fail);
    return () => {
      active = false;
      clearTimeout(timer);
      if (knocking) release(knocking);
    };
  }, [apiBaseURL, attempt, displayName, target]);

  const { colors } = useTheme();
  const retry = () => {
    setWaiting(null);
    setAttempt((current) => current + 1);
  };
  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      <View style={styles.root}>{waiting ? <ChalkArrival callName={waiting.spaceName} colorScheme={colorScheme} onCancel={onCancel} onRetry={retry} state={waiting.state} /> : <Joining callName={joiningName(target, displayName)} />}</View>
    </View>
  );
}

/** T1 as drawn: the limbo on the call background. */
function Joining({ callName }: { readonly callName: string }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]} testID="join.joining">
      <Limbo callName={callName} recording={false} state={{ kind: "joining", rejoining: false }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
