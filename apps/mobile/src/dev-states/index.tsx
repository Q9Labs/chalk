import { useEffect, useMemo, useState } from "react";
import { LogBox, Text, View } from "react-native";
import { Chalk } from "@q9labsai/chalk-react-native";
import type { DevScenario } from "@q9labsai/chalk-react-native/dev";
import { callStateForScreen, scenarioForCodes } from "./scenario";
import { parseCodes, type ScenarioCode } from "./codes";
import { createFixtureClient } from "./fixtures";
import { AppStates, hasAppStates } from "./app-states";
import { supportsCallState } from "./sdk-capabilities";
import { MeasuredView, sendMeasurements, registerSDKMeasurement } from "./measurement";

const dev: typeof import("@q9labsai/chalk-react-native/dev") | null = __DEV__ ? require("@q9labsai/chalk-react-native/dev") : null;
// Install before Chalk's measurement effects mount, not in a parent effect afterwards.
if (dev) {
  dev.setMeasurementRegistry(registerSDKMeasurement);
  // Keep native warnings in the logs without a development overlay covering capture chrome.
  LogBox.ignoreAllLogs();
}

export function DevStates({ url }: { url: string }) {
  const [error, setError] = useState<string | null>(null);
  const params = useMemo(() => new URL(url).searchParams, [url]);
  const scenario = useMemo<{ codes: ScenarioCode[]; error: string | null }>(() => {
    try {
      return { codes: parseCodes(params.get("codes") ?? "D1,P3,A2,V1"), error: null };
    } catch (cause) {
      return { codes: [], error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [params]);
  const state = useMemo(() => scenarioForCodes(scenario.codes), [scenario]);
  const appSurface = ["home", "name"].includes(state.screen) || (state.screen === "joining" && hasAppStates) || params.get("app") === "ready";
  const client = useMemo(() => createFixtureClient(scenario.codes), [scenario]);
  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => {
    setError(null);
    const sheet = params.get("sheet");
    const menu = params.get("menu");
    if ((sheet && !["more", "people", "chat", "details", "route"].includes(sheet)) || (menu && !["leave", "route"].includes(menu))) {
      setError(`SDK scenario adapter does not support sheet=${sheet}, menu=${menu}`);
      return;
    }
    const forced: DevScenario = {
      ...callStateForScreen(state.screen),
      ...(sheet === "more" || sheet === "people" || sheet === "chat" || sheet === "details" || sheet === "route" ? { sheet } : {}),
      ...(menu === "leave" || menu === "route" ? { menu } : {}),
      layout: state.layout === "grid" ? "grid" : "spotlight",
      shareAspect: state.aspect,
      ...(params.get("pinned") ? { pinned: params.get("pinned") ?? undefined } : {}),
      screenSlots: scenario.codes.includes("C2")
        ? {
            "person-1": (
              <View style={{ flex: 1, backgroundColor: "#273A56" }}>
                <Text style={{ color: "white" }}>Quarterly plan</Text>
              </View>
            ),
          }
        : {},
      audioRoutes: {
        routes: [{ id: "earpiece", kind: "earpiece", name: "Phone" }, { id: "speaker", kind: "speaker", name: "Speaker" }, ...(scenario.codes.includes("K3") ? [{ id: "bluetooth", kind: "bluetooth" as const, name: "AirPods Pro" }] : [])],
        selected: scenario.codes.includes("K3") ? "bluetooth" : "speaker",
      },
      // Only person-2 has fake video. Everyone else has the camera off, so their Facehash draws.
      videoSlots: Object.fromEntries(
        client
          .getSnapshot()
          .participants.roster.filter((_, index) => index === 2)
          .map((person) => [person.participantId, <View key={person.participantId} style={{ flex: 1, backgroundColor: "#4D5D73" }} />]),
      ),
    };
    dev?.setDevScenario(forced);
    const timer = setTimeout(() => {
      try {
        for (const code of state.events) client.fire(code);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 100);
    return () => {
      clearTimeout(timer);
      dev?.setDevScenario(null);
    };
  }, [client, params, state.events, state.screen, state.layout, state.aspect, scenario.codes]);
  useEffect(() => {
    const endpoint = params.get("dump");
    if (!endpoint || scenario.error) return;
    const timer = setTimeout(() => {
      void sendMeasurements(endpoint, (params.get("ids") ?? "").split(",").filter(Boolean), params.get("capture") ?? scenario.codes.join(","), appSurface ? "app" : "sdk").catch((cause) => setError(String(cause)));
    }, 800);
    return () => clearTimeout(timer);
  }, [params, scenario, appSurface]);
  if (scenario.error || error) return <Text accessibilityRole="alert">{scenario.error ?? error}</Text>;
  if (!supportsCallState && ["knocking", "refused", "hold", "full", "ended", "removed"].includes(state.screen)) return <Text accessibilityRole="alert">This fixture requires the mobile-redesign-states SDK callState seam.</Text>;
  const supported: readonly ScenarioCode[] = ["D1", "D2", "O1", "O2", "P1", "P2", "P3", "P4", "U1", "U2", "V1", "V2", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "T1", "T2", "T3", "T4", "T5", "T6", "C1", "C2", "C3", "G1", "G2", "S1", "S2", "S3", "S4", "W1", "K3", "K8", "F4", "F5", "F6"];
  const unsupported = scenario.codes.filter((code) => !supported.includes(code));
  if (unsupported.length) return <Text accessibilityRole="alert">SDK scenario adapter does not support: {unsupported.join(",")}</Text>;
  return (
    <MeasuredView testID="harness.ready" style={{ flex: 1 }}>
      {appSurface ? <AppStates screen={state.screen} theme={state.theme} ready={params.get("app") === "ready"} call={<Chalk key={url} client={client} colorScheme={state.theme} soundsEnabled={false} />} /> : <Chalk key={url} client={client} colorScheme={state.theme} soundsEnabled={false} />}
    </MeasuredView>
  );
}
