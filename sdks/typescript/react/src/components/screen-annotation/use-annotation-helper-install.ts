import { useSyncExternalStore } from "react";
import type { ScreenAnnotationOptions } from "./model";

export function useAnnotationHelperInstall(annotation?: Pick<ScreenAnnotationOptions, "client" | "helper">): string | undefined {
  const url = annotation?.helper?.installUrl;
  const client = url ? annotation?.client : undefined;
  const active = useSyncExternalStore(
    (listener) => client?.subscribe(listener) ?? (() => {}),
    () => client?.getSnapshot().status === "ready",
    () => false,
  );
  return active ? url : undefined;
}
