import { createContext, useContext, useEffect, useMemo, type PropsWithChildren } from "react";
import type React from "react";

import { createWebTelemetry, type WebTelemetry, type WebTelemetryJourney } from "./telemetry";
import { installWebTelemetryLifecycle } from "./telemetryLifecycle";

type WebTelemetryContextValue = {
  readonly telemetry: WebTelemetry;
  readonly journey: WebTelemetryJourney;
};

const WebTelemetryContext = createContext<WebTelemetryContextValue | null>(null);

export function WebTelemetryProvider({ children }: PropsWithChildren): React.JSX.Element {
  const value = useMemo<WebTelemetryContextValue>(() => {
    const telemetry = createWebTelemetry();
    return { telemetry, journey: telemetry.startJourney({ kind: "web.application" }) };
  }, []);

  useEffect(() => installWebTelemetryLifecycle(value.telemetry, value.journey), [value]);

  return <WebTelemetryContext.Provider value={value}>{children}</WebTelemetryContext.Provider>;
}

export function useWebTelemetry(): WebTelemetryContextValue {
  const value = useContext(WebTelemetryContext);
  if (!value) throw new Error("Web telemetry must be provided before entering a Space.");
  return value;
}
