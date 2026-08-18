import { createContext, useContext, type ReactNode } from "react";
import type React from "react";

import type { ThemeSkin } from "./theme";

const SkinContext = createContext<ThemeSkin>("chalk");

export interface SkinProviderProps {
  readonly skin?: ThemeSkin;
  readonly children: ReactNode;
}

export function SkinProvider({ children, skin = "chalk" }: SkinProviderProps): React.JSX.Element {
  return <SkinContext.Provider value={skin}>{children}</SkinContext.Provider>;
}

export function useSkin(): ThemeSkin {
  return useContext(SkinContext);
}
