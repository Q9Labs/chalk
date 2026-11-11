import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { DeviceAccessStore, type DeviceAccessSnapshot } from "./store";

const DeviceAccessContext = createContext<DeviceAccessStore | null>(null);

/** SpaceView shares one store with its dock, so keyboard shortcuts and dock buttons report to the same card. */
export const DeviceAccessProvider = DeviceAccessContext.Provider;

export function useDeviceAccess(): { readonly store: DeviceAccessStore; readonly snapshot: DeviceAccessSnapshot } {
  const [own] = useState(() => new DeviceAccessStore());
  const store = useContext(DeviceAccessContext) ?? own;
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) };
}
