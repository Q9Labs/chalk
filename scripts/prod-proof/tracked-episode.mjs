import { trackEpisode } from "./proofs.mjs";

// Starts an Episode in the Space and records it for cleanup; path is the Space's Episode collection.
export async function startTrackedEpisode(run, space) {
  const path = `${run.tenantPath}/spaces/${space.id}/episodes`;
  const episode = await run.apiRequest("POST", path, { metadata: { proof_run_id: run.runId } });
  await trackEpisode(run, space, episode);
  return { path, episode };
}
