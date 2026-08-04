"use client";

import type { SpaceClient } from "@q9labsai/chalk-client";
import { createContext, type PropsWithChildren } from "react";
import type React from "react";

export const SpaceClientContext = createContext<SpaceClient | null>(null);

export type ChalkProviderProps = PropsWithChildren<{
  readonly client: SpaceClient;
}>;

export function ChalkProvider({ children, client }: ChalkProviderProps): React.JSX.Element {
  return <SpaceClientContext.Provider value={client}>{children}</SpaceClientContext.Provider>;
}
