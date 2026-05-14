import type { ConferenceClientConfig } from "@q9labs/chalk-core";

type WideEventsConfig = NonNullable<ConferenceClientConfig["wideEvents"]>;

export function getWideEventsMemoDependencies(wideEvents?: ConferenceClientConfig["wideEvents"]): readonly [WideEventsConfig["enabled"] | undefined, WideEventsConfig["includeDebugInfo"] | undefined, WideEventsConfig["handler"] | null] {
  return [wideEvents?.enabled, wideEvents?.includeDebugInfo, wideEvents?.handler ?? null] as const;
}
