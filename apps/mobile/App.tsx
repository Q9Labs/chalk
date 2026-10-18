import { recordDevDiagnosticsLifecycleEvent, recordDiagnosticsFailure, resolveDevDiagnosticsMode, setDevDiagnosticsConnection, setDevDiagnosticsDevice, setDevDiagnosticsEnvironment } from "@q9labsai/chalk-react-native/diagnostics";
import { getDeviceInfo } from "@q9labsai/chalk-react-native/runtime";
import { ChalkUI, useToasts } from "@q9labsai/chalk-react-native/ui";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking } from "react-native";
import { Splash } from "./src/brand/Splash";
import { CallScreen } from "./src/call/CallScreen";
import { HomeScreen } from "./src/home/HomeScreen";
import { useRecentCalls, type RecentCall, type RecentCalls } from "./src/home/recent-calls";
import { JoiningScreen, type ArrivedCall, type JoinTarget } from "./src/join/JoiningScreen";
import { NameStep } from "./src/join/NameStep";
import { getApiBaseURL } from "./src/lib/mobile-config";
import { parseSpaceLink, type SpaceRoute } from "./src/lib/spaces";
import { useCallPreferences, type StoredCallPreferences } from "./src/preferences/call-preferences";
import { loadOnboardingState, saveOnboardingState } from "./src/screens/onboarding-store";

void SplashScreen.preventAutoHideAsync();

/** What the app shows: Home, then the name step when there's no name, joining, and the call. */
type Step = { readonly kind: "home" } | { readonly kind: "name"; readonly target: JoinTarget } | { readonly kind: "joining"; readonly target: JoinTarget; readonly name: string } | { readonly kind: "call"; readonly call: ArrivedCall };

export default function App(): React.JSX.Element {
  const apiBaseURL = useMemo(() => getApiBaseURL(), []);
  const diagnosticsMode = useMemo(() => resolveDevDiagnosticsMode({ isDevRuntime: __DEV__, apiBaseURL }), [apiBaseURL]);
  const diagnosticsEnabled = diagnosticsMode.enabled;
  const reportError = useCallback(
    (source: string) => (cause: unknown) => {
      if (diagnosticsEnabled) recordDiagnosticsFailure(source, cause instanceof Error ? cause.message : String(cause));
    },
    [diagnosticsEnabled],
  );
  const preferences = useCallPreferences(useMemo(() => reportError("load-preferences"), [reportError]));
  const recentCalls = useRecentCalls(useMemo(() => reportError("recent-calls"), [reportError]));
  const [name, setName] = useState<string | null | undefined>(undefined);
  const [openedLink, setOpenedLink] = useState<SpaceRoute | null | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    void loadOnboardingState()
      .then(
        (state) => state.displayName,
        (cause: unknown) => {
          reportError("load-display-name")(cause);
          return null;
        },
      )
      .then((stored) => {
        if (mounted) setName(stored);
      });
    void Linking.getInitialURL()
      .then(
        (url) => (url ? parseSpaceLink(url) : null),
        (cause: unknown) => {
          reportError("initial-link")(cause);
          return null;
        },
      )
      .then((route) => {
        if (mounted) setOpenedLink(route);
      });
    return () => {
      mounted = false;
    };
  }, [reportError]);

  const ready = preferences && recentCalls && name !== undefined && openedLink !== undefined;
  return (
    <ChalkUI colorScheme={preferences?.colorScheme ?? "dark"}>
      {ready ? (
        <Shell apiBaseURL={apiBaseURL} diagnosticsEnabled={diagnosticsEnabled} name={name} onNameChange={setName} openedLink={openedLink} preferences={preferences} recentCalls={recentCalls} reportError={reportError} buildProfile={diagnosticsMode.buildProfile} />
      ) : (
        <Splash onLayout={() => void SplashScreen.hideAsync()} />
      )}
      {/* Dev states: the harness lane mounts its route on the next line. */}
    </ChalkUI>
  );
}

type ShellProps = {
  readonly apiBaseURL: string;
  readonly buildProfile: string;
  readonly diagnosticsEnabled: boolean;
  readonly name: string | null;
  readonly onNameChange: (name: string) => void;
  readonly openedLink: SpaceRoute | null;
  readonly preferences: StoredCallPreferences;
  readonly recentCalls: RecentCalls;
  readonly reportError: (source: string) => (cause: unknown) => void;
};

function Shell({ apiBaseURL, buildProfile, diagnosticsEnabled, name, onNameChange, openedLink, preferences, recentCalls, reportError }: ShellProps): React.JSX.Element {
  const toasts = useToasts();
  const [step, setStep] = useState<Step>(() => (openedLink ? (name ? { kind: "joining", target: { kind: "link", route: openedLink }, name } : { kind: "name", target: { kind: "link", route: openedLink } }) : { kind: "home" }));

  const join = useCallback((target: JoinTarget) => setStep(name ? { kind: "joining", target, name } : { kind: "name", target }), [name]);
  const goHome = useCallback(() => setStep({ kind: "home" }), []);
  const saveName = useCallback(
    (next: string) => {
      onNameChange(next);
      saveOnboardingState(next).catch(reportError("save-display-name"));
    },
    [onNameChange, reportError],
  );

  // App links and chalk:// links open straight into joining.
  useEffect(() => {
    const subscription = Linking.addEventListener("url", ({ url }) => {
      const route = parseSpaceLink(url);
      if (route) join({ kind: "link", route });
    });
    return () => subscription.remove();
  }, [join]);

  useEffect(() => {
    if (!diagnosticsEnabled) return;
    const route = step.kind === "call" ? step.call.route : step.kind !== "home" && step.target.kind === "link" ? step.target.route : null;
    recordDevDiagnosticsLifecycleEvent("navigation", `App step: ${step.kind}`, route ? `Space: ${route.space}` : undefined);
    setDevDiagnosticsEnvironment({ apiBaseURL, buildProfile, routeKind: step.kind === "home" ? "home" : "space", routeSource: route?.source ?? null, routeSpaceId: route?.space ?? null });
    setDevDiagnosticsDevice(getDeviceInfo());
    if (step.kind === "home") setDevDiagnosticsConnection(null);
  }, [apiBaseURL, buildProfile, diagnosticsEnabled, step]);

  const joinFailed = useCallback(
    (cause: unknown) => {
      reportError("join")(cause);
      setStep({ kind: "home" });
      toasts.show({ kind: "error", dismissible: true, wrap: true, message: cause instanceof Error ? `Couldn’t join the call. ${cause.message}` : "Couldn’t join the call." });
    },
    [reportError, toasts],
  );
  const joinRecent = useCallback(
    (call: RecentCall) => {
      const route = parseSpaceLink(call.link);
      if (route) join({ kind: "link", route: { ...route, spaceName: call.name } });
    },
    [join],
  );

  switch (step.kind) {
    case "home":
      return <HomeScreen name={name} onJoin={(route) => join({ kind: "link", route })} onJoinRecent={joinRecent} onSaveName={saveName} onStartCall={() => join({ kind: "start" })} preferences={preferences} recentCalls={recentCalls} />;
    case "name":
      return (
        <NameStep
          onCancel={goHome}
          onSubmit={(next) => {
            saveName(next);
            setStep({ kind: "joining", target: step.target, name: next });
          }}
        />
      );
    case "joining":
      return <JoiningScreen apiBaseURL={apiBaseURL} displayName={step.name} onArrived={(call) => setStep({ kind: "call", call })} onFailed={joinFailed} target={step.target} />;
    case "call":
      return <CallScreen apiBaseURL={apiBaseURL} call={step.call} onClose={goHome} onError={reportError("leave")} onRemember={recentCalls.remember} preferences={preferences} />;
  }
}
