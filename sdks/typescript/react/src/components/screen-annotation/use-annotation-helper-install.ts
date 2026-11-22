import { useSyncExternalStore } from "react";
import type { ScreenAnnotationOptions } from "./model";

export function useAnnotationHelperInstall(annotation?: Pick<ScreenAnnotationOptions, "client" | "helper">): string | undefined {
  const url = annotation?.helper?.installUrl;
  const client = url ? annotation?.client : undefined;
  const active = useSyncExternalStore(
    (listener) => client?.subscribe(listener) ?? (() => {}),
    () => {
      const snapshot = client?.getSnapshot();
      return snapshot?.status === "ready" && snapshot.state !== null;
    },
    () => false,
  );
  return active ? url : undefined;
}
