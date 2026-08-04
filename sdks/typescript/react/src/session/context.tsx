"use client";

import { createContext, useRef, type PropsWithChildren } from "react";

import { toSpaceClientStore, type SpaceClientStore, type SpaceClientStoreInput } from "../client-compat";

export const ChalkSessionContext = createContext<SpaceClientStore | null>(null);

export type ChalkProviderProps = PropsWithChildren<{
  readonly session: SpaceClientStoreInput;
}>;

export function ChalkProvider({ children, session }: ChalkProviderProps) {
  const storeRef = useRef<{ readonly input: SpaceClientStoreInput; readonly store: SpaceClientStore } | null>(null);
  if (storeRef.current?.input !== session) storeRef.current = { input: session, store: toSpaceClientStore(session) };

  return <ChalkSessionContext.Provider value={storeRef.current.store}>{children}</ChalkSessionContext.Provider>;
}
