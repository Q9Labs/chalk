import { lazy, Suspense, type ComponentProps } from "react";
import { loadDeviceAccessCard } from "./load-card";

const DeviceAccessCard = lazy(() => loadDeviceAccessCard().then((module) => ({ default: module.DeviceAccessCard })));

/** The card and its browser logos load on the first refusal, so a call that never has one never downloads them. */
export function LazyDeviceAccessCard(props: ComponentProps<typeof DeviceAccessCard>) {
  return (
    <Suspense fallback={null}>
      <DeviceAccessCard {...props} />
    </Suspense>
  );
}
