/** Dev-build-only fault triggers for the crash/performance fault scenarios (VITE_CHALK_DEV_FAULT). Production builds never call this. */

export const DEV_FAULTS = ["render_throw_at_60s", "unhandled_error", "unhandled_rejection", "block_main_6s", "leak_300mb"] as const;
export type DevFault = (typeof DEV_FAULTS)[number];

const held: unknown[] = [];

/** Arms the named fault. Called once when the call page mounts; each fault fires itself after its own delay. */
export function armDevFault(fault: string | undefined): void {
  switch (fault) {
    case "render_throw_at_60s":
      setTimeout(() => {
        window.dispatchEvent(new Event("chalk:dev-fault:render-throw"));
      }, 60_000);
      break;
    case "unhandled_error":
      setTimeout(() => {
        throw new Error("dev fault: unhandled_error");
      }, 30_000);
      break;
    case "unhandled_rejection":
      setTimeout(() => {
        void Promise.reject(new Error("dev fault: unhandled_rejection"));
      }, 30_000);
      break;
    case "block_main_6s": {
      setTimeout(() => {
        const until = performance.now() + 6000;
        while (performance.now() < until) {
          // Busy loop: the main thread never yields, so the worker's ping round trip stalls.
        }
      }, 30_000);
      break;
    }
    case "leak_300mb": {
      setInterval(() => {
        held.push(new ArrayBuffer(10 * 1024 * 1024));
      }, 2000);
      break;
    }
    default:
      break;
  }
}
