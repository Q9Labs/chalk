"use client";

import type { SpaceClient } from "@q9labsai/chalk-client";
import { createContext, type PropsWithChildren } from "react";
import type React from "react";

import type { ChalkAdmissionControl } from "./admission-control";

export const SpaceClientContext = createContext<SpaceClient | null>(null);
export const AdmissionControlContext = createContext<ChalkAdmissionControl | null>(null);

export type ChalkProviderProps = PropsWithChildren<{
  readonly client: SpaceClient;
  readonly admissionControl?: ChalkAdmissionControl;
}>;

export function ChalkProvider({ children, client, admissionControl }: ChalkProviderProps): React.JSX.Element {
  return (
    <SpaceClientContext.Provider value={client}>
      <AdmissionControlContext.Provider value={admissionControl ?? null}>{children}</AdmissionControlContext.Provider>
    </SpaceClientContext.Provider>
  );
}
