import type { SpaceClient } from "@q9labsai/chalk-client";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

export type ChalkProviderProps = {
  readonly children: ReactNode;
  readonly client: SpaceClient;
};

const SpaceClientContext = createContext<SpaceClient | null>(null);

export function ChalkProvider({ children, client }: ChalkProviderProps): React.JSX.Element {
  const value = useMemo(() => client, [client]);
  return <SpaceClientContext.Provider value={value}>{children}</SpaceClientContext.Provider>;
}

export function useSpaceClient(): SpaceClient {
  const client = useContext(SpaceClientContext);
  if (!client) throw new Error("Chalk hooks must be used within a ChalkProvider.");
  return client;
}
