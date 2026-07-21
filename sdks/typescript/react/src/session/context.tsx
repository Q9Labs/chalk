"use client";

import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import { createContext, type PropsWithChildren } from "react";

export const ChalkSessionContext = createContext<ChalkSessionStore | null>(null);

export type ChalkProviderProps = PropsWithChildren<{
  readonly session: ChalkSessionStore;
}>;

export function ChalkProvider({ children, session }: ChalkProviderProps) {
  return <ChalkSessionContext.Provider value={session}>{children}</ChalkSessionContext.Provider>;
}
