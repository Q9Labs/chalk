import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useSafeAreaFrame, useSafeAreaInsets, type EdgeInsets } from "react-native-safe-area-context";
import { arrangementFor, type Arrangement } from "./regions";

export type DeviceLayout = {
  readonly arrangement: Arrangement;
  /** True for `portrait` and `landscape`: the phone look (bottom sheets, 52 pt dock, 48 pt menu rows). */
  readonly phone: boolean;
  readonly width: number;
  readonly height: number;
  readonly insets: EdgeInsets;
};

const DeviceLayoutContext = createContext<DeviceLayout | null>(null);

export function DeviceLayoutProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { width, height } = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const value = useMemo<DeviceLayout>(() => {
    const arrangement = arrangementFor(width, height);
    return { arrangement, phone: arrangement !== "pad", width, height, insets };
  }, [height, insets, width]);
  return <DeviceLayoutContext.Provider value={value}>{children}</DeviceLayoutContext.Provider>;
}

export function useDeviceLayout(): DeviceLayout {
  const layout = useContext(DeviceLayoutContext);
  if (!layout) throw new Error("Chalk primitives must be rendered inside <Chalk>.");
  return layout;
}
