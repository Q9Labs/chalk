import { lazy, Suspense, type ComponentProps } from "react";
import { loadDeviceAccessCard } from "./load-card";

const DeviceAccessCard = lazy(() => loadDeviceAccessCard().then((module) => ({ default: module.DeviceAccessCard })));

const DeviceAccessWaiting = lazy(() => import("./DeviceAccessWaiting").then((module) => ({ default: module.DeviceAccessWaiting })).catch(() => ({ default: () => null })));

/** The hint is optional, so a failed download leaves it out instead of throwing in render. */
export function LazyDeviceAccessWaiting(props: ComponentProps<typeof DeviceAccessWaiting>) {
  return (
    <Suspense fallback={null}>
      <DeviceAccessWaiting {...props} />
    </Suspense>
  );
}

/** The card and its browser logos load on the first refusal, so a call that never has one never downloads them. */
export function LazyDeviceAccessCard(props: ComponentProps<typeof DeviceAccessCard>) {
  return (
    <Suspense fallback={null}>
      <DeviceAccessCard {...props} />
    </Suspense>
  );
}
