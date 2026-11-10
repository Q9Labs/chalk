import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { browserPorts } from "./ports";
import { DeviceAccessStore, type DeviceAccessSnapshot } from "./store";

const SERVER_SNAPSHOT: DeviceAccessSnapshot = { issues: {}, permissions: { microphone: "unknown", camera: "unknown" } };
const DeviceAccessContext = createContext<DeviceAccessStore | null>(null);

/** SpaceView shares one store with its dock, so keyboard shortcuts and dock buttons report to the same card. */
export const DeviceAccessProvider = DeviceAccessContext.Provider;

export function useDeviceAccessStore(): DeviceAccessStore {
  const [own] = useState(() => new DeviceAccessStore(browserPorts()));
  return useContext(DeviceAccessContext) ?? own;
}

export function useDeviceAccess(): { readonly store: DeviceAccessStore; readonly snapshot: DeviceAccessSnapshot } {
  const store = useDeviceAccessStore();
  return { store, snapshot: useSyncExternalStore(store.subscribe, store.getSnapshot, () => SERVER_SNAPSHOT) };
}
