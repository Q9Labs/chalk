import { useCallback, useEffect, useState } from "react";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import { useDevScenario } from "../frame/dev-scenario";
import type { IconName } from "../icons/Icon";

export type AudioRouteKind = "earpiece" | "speaker" | "bluetooth" | "wired";

/** One place the call's sound can play. Bluetooth and wired headsets carry their device name. */
export type AudioRoute = { readonly id: string; readonly kind: AudioRouteKind; readonly name: string };

export type AudioRoutes = { readonly routes: readonly AudioRoute[]; readonly selected: string };

export type AudioOutput = AudioRoutes & {
  readonly current: AudioRoute;
  readonly select: (id: string) => Promise<void>;
};

type NativeAudioRouteModule = {
  readonly eventName: string;
  readonly addListener: (eventName: string) => void;
  readonly removeListeners: (count: number) => void;
  readonly getRoutes: () => Promise<AudioRoutes>;
  readonly selectRoute: (id: string) => Promise<AudioRoutes>;
};

const nativeModule: NativeAudioRouteModule | undefined = NativeModules.ChalkAudioRouteModule;
const emitter = nativeModule ? new NativeEventEmitter(nativeModule) : null;

export const routeIcons: Readonly<Record<AudioRouteKind, IconName>> = { earpiece: "earpiece", speaker: "vol", bluetooth: "buds", wired: "buds" };

/** The mockup's `ROUTEN`: the phone's own speaker is "iPhone" on iOS and "Phone" on Android. */
export function routeName(route: AudioRoute): string {
  if (route.kind === "speaker") return "Speaker";
  if (route.kind === "earpiece") return Platform.OS === "ios" ? "iPhone" : "Phone";
  return route.name;
}

/**
 * The audio output button's state (R1), from the SDK's native route module. Null when the app's
 * native build doesn't include the module yet, so the dock leaves the button out.
 */
export function useAudioOutput(): AudioOutput | null {
  const scenario = useDevScenario().audioRoutes;
  const [state, setState] = useState<AudioRoutes | null>(null);
  // In the harness, picking a route moves the check like a real switch would.
  const [scenarioSelected, setScenarioSelected] = useState<string | null>(null);
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing native audio-route subscription cleanup.
  useEffect(() => {
    if (!nativeModule || !emitter) return;
    let live = true;
    nativeModule
      .getRoutes()
      .then((next) => live && setState(next))
      .catch(() => undefined);
    const subscription = emitter.addListener(nativeModule.eventName, (next: AudioRoutes) => setState(next));
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  const select = useCallback(async (id: string) => {
    if (!nativeModule) return;
    setState(await nativeModule.selectRoute(id));
  }, []);
  const routes = scenario ? { ...scenario, selected: scenarioSelected ?? scenario.selected } : state;
  if (!routes) return null;
  const current = routes.routes.find((route) => route.id === routes.selected) ?? routes.routes[0];
  if (!current) return null;
  return { ...routes, current, select: scenario ? async (id) => setScenarioSelected(id) : select };
}
