import { setTimeout as delay } from "node:timers/promises";

export async function requestCleanupEnd(call, path, wait = delay) {
  try {
    await requestEpisodeEnd(call, path);
  } catch (error) {
    if (error.status !== 409 || error.apiCode !== "episode.control_busy") throw error;
    // Provider cleanup may own the coordinator for 35 seconds after socket loss.
    await wait(35_000);
    await requestEpisodeEnd(call, path);
  }
}

export function requestEpisodeEnd(call, path) {
  return call("POST", `${path}/end`, {}).catch(async (error) => {
    if (error.status !== 409 || error.apiCode !== "episode.not_active") throw error;
    const episode = await call("GET", path);
    if (!["ending", "ended"].includes(episode.status)) throw error;
  });
}
