import { Limbo, useTheme } from "@q9labsai/chalk-react-native/ui";
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { cleanupSpaceArrival, createPublicSpaceRoute, prepareSpaceArrival, type MobileSpaceArrival, type SpaceRoute } from "../lib/spaces";

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
  readonly onArrived: (call: ArrivedCall) => void;
  readonly onFailed: (cause: unknown) => void;
};

function joiningName(target: JoinTarget, displayName: string): string {
  if (target.kind === "link") return target.route.spaceName ?? target.route.space;
  return `${displayName.split(/\s+/u)[0]}’s call`;
}

/**
 * T1: the call's limbo while the app gets access. `Chalk` shows the same limbo while it connects,
 * so the hand-over is seamless. Leaving before access arrives gives the arrival back.
 */
export function JoiningScreen({ apiBaseURL, target, displayName, onArrived, onFailed }: JoiningScreenProps): React.JSX.Element {
  const callbacks = useRef({ onArrived, onFailed });
  callbacks.current = { onArrived, onFailed };

  useEffect(() => {
    let active = true;
    const arrive =
      target.kind === "start" ? createPublicSpaceRoute({ apiBaseURL, displayName }).then(({ arrival, route }) => ({ arrival, route, started: true })) : prepareSpaceArrival({ apiBaseURL, displayName, route: target.route }).then((arrival) => ({ arrival, route: target.route, started: false }));
    arrive.then(
      (call) => {
        if (active) callbacks.current.onArrived(call);
        else void cleanupSpaceArrival({ apiBaseURL, credential: call.arrival.credential }).catch(() => undefined);
      },
      (cause: unknown) => {
        if (active) callbacks.current.onFailed(cause);
      },
    );
    return () => {
      active = false;
    };
  }, [apiBaseURL, displayName, target]);

  return <Joining callName={joiningName(target, displayName)} />;
}

/** T1 as drawn: the limbo on the call background. */
function Joining({ callName }: { readonly callName: string }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]} testID="join.joining">
      <Limbo message={`Joining ${callName}…`} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
