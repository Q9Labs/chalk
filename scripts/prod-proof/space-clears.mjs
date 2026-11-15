import { ProofError } from "./runtime.mjs";

// An Episode still ending, or someone else's, makes Create Episode answer 409 episode.capacity_exceeded; wait up to 30 x 3 s for it.
const spaceBusyPolls = 30;
const spaceBusyPollMs = 3_000;
export async function createEpisodeWhenSpaceClears(run, space) {
  for (let poll = 0; ; poll++) {
    const startedAt = performance.now();
    try {
      const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: run.runId } });
      return { episode, createMs: performance.now() - startedAt };
    } catch (error) {
      if (error.status !== 409 || error.apiCode !== "episode.capacity_exceeded") throw error;
      if (poll === spaceBusyPolls) throw new ProofError("proof-space-busy", `The proof Space still has a live Episode after ${(spaceBusyPolls * spaceBusyPollMs) / 1000} seconds`);
      await run.wait(spaceBusyPollMs);
    }
  }
}
