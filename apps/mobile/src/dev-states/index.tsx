import { useEffect, useMemo, useState } from "react";
import { PanResponder, Pressable, ScrollView, Text, View } from "react-native";
import * as SDK from "@q9labsai/chalk-react-native";
import type { SpaceClient } from "@q9labsai/chalk-client";
import type { ComponentType } from "react";
import { scenarioForCodes } from "./scenario";
import { parseCodes, type ScenarioCode } from "./codes";
import { createFixtureClient } from "./fixtures";
import { MeasuredText, MeasuredView, sendMeasurements } from "./measurement";

function isChalkExport(value: object): value is { Chalk: ComponentType<{ client: SpaceClient; colorScheme: "dark" | "light"; soundsEnabled: boolean }> } {
  if (!("Chalk" in value)) return false;
  const component = value.Chalk;
  return typeof component === "function" || (component !== null && typeof component === "object" && "$$typeof" in component && (component.$$typeof === Symbol.for("react.memo") || component.$$typeof === Symbol.for("react.forward_ref")));
}

export function DevStates({ url }: { url: string }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const drag = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 10,
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > 40) setSheet(false);
        },
      }),
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const params = useMemo(() => new URL(url).searchParams, [url]);
  const scenario = useMemo<{ codes: ScenarioCode[]; error: string | null }>(() => {
    try {
      return { codes: parseCodes(params.get("codes") ?? "D1,P3,A2,V1"), error: null };
    } catch (cause) {
      return { codes: [], error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [params]);
  const state = scenarioForCodes(scenario.codes);
  const client = useMemo(() => createFixtureClient(scenario.codes), [scenario]);
  useEffect(() => () => client.dispose(), [client]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        for (const code of state.events) setNotice(client.fire(code));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [client]);
  useEffect(() => {
    setError(null);
    const endpoint = params.get("dump");
    if (!endpoint || scenario.error) return;
    const timer = setTimeout(() => {
      void sendMeasurements(endpoint, (params.get("ids") ?? "").split(",").filter(Boolean), scenario.codes.join(",")).catch((cause) => setError(String(cause)));
    }, 800);
    return () => clearTimeout(timer);
  }, [params, scenario]);
  if (scenario.error || error) return <Text accessibilityRole="alert">{scenario.error ?? error}</Text>;
  if (isChalkExport(SDK)) {
    const supported: readonly ScenarioCode[] = ["D1", "D2", "O1", "P1", "P2", "P3", "P4", "U1", "U2", "V1", "V2", "A2", "A3", "A5", "T1", "T5", "C1"];
    const unsupported = scenario.codes.filter((code) => !supported.includes(code));
    if (unsupported.length) return <Text accessibilityRole="alert">SDK scenario adapter does not support: {unsupported.join(",")}</Text>;
    return (
      <MeasuredView testID="harness.ready" style={{ flex: 1 }}>
        <SDK.Chalk client={client} colorScheme={state.theme} soundsEnabled={false} />
      </MeasuredView>
    );
  }
  const light = scenario.codes.includes("V2");
  return (
    <MeasuredView testID="harness.ready" style={{ flex: 1, backgroundColor: light ? "#f5f5f5" : "#171717", padding: 24, justifyContent: "center", gap: 12 }}>
      <Text style={{ color: light ? "#171717" : "#ffffff" }}>Harness stand-in · SDK Chalk is not available</Text>
      <Text style={{ color: light ? "#171717" : "#ffffff" }}>
        {scenario.codes.join(",")} · {state.screen} · {client.getSnapshot().participants.roster.length} participants
      </Text>
      {notice ? (
        <Text accessibilityRole="alert" style={{ color: light ? "#171717" : "#ffffff" }}>
          {notice}
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="More options" onPress={() => setSheet(true)} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={{ color: light ? "#171717" : "#ffffff" }}>More options</Text>
      </Pressable>
      {sheet ? (
        <MeasuredView testID="harness.sheet" {...drag.panHandlers} style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 320, backgroundColor: light ? "#ffffff" : "#1d1f23", borderTopLeftRadius: 22, borderTopRightRadius: 22, zIndex: 5, padding: 24 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setSheet(false)}>
            <Text style={{ color: light ? "#171717" : "#ffffff" }}>Stand-in sheet · Close</Text>
          </Pressable>
        </MeasuredView>
      ) : null}
      <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 8 }}>
        {client.getSnapshot().participants.roster.map((person) => (
          <View key={person.participantId} style={{ height: 64, backgroundColor: "#4d5d73", borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ width: 40, height: 48, alignItems: "center", justifyContent: "flex-end" }}>
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: "#93a0ae" }} />
              <View style={{ width: 36, height: 22, borderTopStartRadius: 18, borderTopEndRadius: 18, backgroundColor: "#93a0ae" }} />
            </View>
            <MeasuredText testID={`harness.name.${person.participantId}`} style={{ color: "#ffffff", fontFamily: "System", fontSize: 14, fontWeight: "400", lineHeight: 20 }}>
              {person.displayName}
            </MeasuredText>
          </View>
        ))}
      </ScrollView>
    </MeasuredView>
  );
}
