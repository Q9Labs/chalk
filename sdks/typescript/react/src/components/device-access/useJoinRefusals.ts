import type { ClientFailure } from "@q9labsai/chalk-client";
import { useEffect } from "react";
import type { DeviceAccessStore } from "./store";

/**
 * A join that went ahead without a microphone or camera the browser refused reports it once here, so its card opens at the first refusal
 * instead of leaving the person with a badge and no steps. `retry` is the command that turns that device on.
 */
export function useJoinRefusals(store: DeviceAccessStore, failure: ClientFailure | null, retry: (device: "microphone" | "camera") => Promise<unknown>): void {
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [subscription] Report the refusal a join carried, once per failure; nothing to release on cleanup.
  useEffect(() => {
    for (const device of failure?.devices ?? []) void store.report(device, failure as ClientFailure, () => retry(device));
  }, [store, failure, retry]);
}
