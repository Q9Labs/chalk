import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

import { createTelemetry, type Telemetry, type TelemetryJourney } from "../telemetry";

export type ChalkProviderProps = {
  readonly children: ReactNode;
  readonly session: ChalkSessionStore;
  readonly telemetry?: TelemetryJourney;
};

type ChalkContextValue = {
  readonly session: ChalkSessionStore;
  readonly telemetry: Telemetry | undefined;
};

const ChalkContext = createContext<ChalkContextValue | null>(null);

export function ChalkProvider({ children, session, telemetry: journey }: ChalkProviderProps): React.JSX.Element {
  const telemetry = useMemo(() => (journey ? createTelemetry(journey) : undefined), [journey]);
  const value = useMemo<ChalkContextValue>(() => ({ session, telemetry }), [session, telemetry]);
  return <ChalkContext.Provider value={value}>{children}</ChalkContext.Provider>;
}

export function useChalkSession(): ChalkSessionStore {
  const context = useContext(ChalkContext);
  if (!context) throw new Error("Chalk session hooks must be used within a ChalkProvider.");
  return context.session;
}

export function useTelemetry(): Telemetry | undefined {
  const context = useContext(ChalkContext);
  if (!context) throw new Error("Chalk session hooks must be used within a ChalkProvider.");
  return context.telemetry;
}
