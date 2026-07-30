import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

import { createNativeTelemetry, type NativeTelemetry, type NativeTelemetryJourney } from "../telemetry";

export type ChalkNativeProviderProps = {
  readonly children: ReactNode;
  readonly session: ChalkSessionStore;
  readonly telemetry?: NativeTelemetryJourney;
};

type ChalkNativeContextValue = {
  readonly session: ChalkSessionStore;
  readonly telemetry: NativeTelemetry | undefined;
};

const ChalkNativeContext = createContext<ChalkNativeContextValue | null>(null);

export function ChalkNativeProvider({ children, session, telemetry: journey }: ChalkNativeProviderProps): React.JSX.Element {
  const telemetry = useMemo(() => (journey ? createNativeTelemetry(journey) : undefined), [journey]);
  const value = useMemo<ChalkNativeContextValue>(() => ({ session, telemetry }), [session, telemetry]);
  return <ChalkNativeContext.Provider value={value}>{children}</ChalkNativeContext.Provider>;
}

export function useChalkSession(): ChalkSessionStore {
  const context = useContext(ChalkNativeContext);
  if (!context) throw new Error("Chalk session hooks must be used within a ChalkNativeProvider.");
  return context.session;
}

export function useNativeTelemetry(): NativeTelemetry | undefined {
  const context = useContext(ChalkNativeContext);
  if (!context) throw new Error("Chalk session hooks must be used within a ChalkNativeProvider.");
  return context.telemetry;
}
