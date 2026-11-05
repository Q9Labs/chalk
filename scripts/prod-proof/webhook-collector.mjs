import { setTimeout as delay } from "node:timers/promises";
import { CatcherRateLimited } from "./webhook-transport.mjs";

// A rate-limited poll is not a failed delivery: skip it and let the proof's own timeout decide.
async function pollOnce(collect, signal, pauses) {
  try {
    await collect(signal);
    return pauses.poll;
  } catch (error) {
    if (error instanceof CatcherRateLimited) return pauses.rateLimited;
    throw error;
  }
}
export function startCollector(run, receiver, collect, pauses = { poll: 2000, rateLimited: 15_000 }) {
  const controller = new AbortController();
  const completion = (async () => {
    try {
      while (!controller.signal.aborted) {
        await delay(await pollOnce(collect, controller.signal, pauses), undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) receiver.failure = error.message;
    }
  })();
  run.resources.push({
    kind: "webhook-collector",
    force: () => controller.abort(),
    dispose: async () => {
      controller.abort();
      await completion;
    },
  });
}
