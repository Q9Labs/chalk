// @ts-check
import { correlation, finding, revision, rows, sameRevision } from "./board-evidence.mjs";
export { applies } from "./board-evidence.mjs";

export const symptom = "board.snapshot_mismatch";
export const expected = "every assembled snapshot agrees with the durable snapshot for its request on scene, revision and element count";

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} input @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} */
export function decide({ readings }) {
  const client = rows(readings["board.client_snapshot"]);
  const sync = rows(readings["board.sync_snapshot"]);
  let matched = 0;
  for (const snapshot of client) {
    const candidates = sync.filter((row) => correlation(snapshot) && correlation(row) === correlation(snapshot));
    if (candidates.length !== 1) continue;
    const [durable] = candidates;
    if (!durable) continue;
    const observed = snapshot.value.board_element_count;
    const expected = durable.value.board_element_count;
    if (typeof observed !== "number" || typeof expected !== "number") continue;
    if (observed !== expected || !sameRevision(snapshot, durable)) {
      return finding(
        snapshot,
        "snapshot",
        `the SDK assembled revision ${revision(snapshot)} with ${observed} elements`,
        "the SDK and Sync reported matching scene, revision and element count for this snapshot request",
        { row: durable, text: `Sync prepared revision ${revision(durable)} with ${expected} elements from Postgres` },
      );
    }
    matched++;
  }
  if (matched > 0 && matched === client.length && matched === sync.length) return { status: "pass" };
  return { status: "unknown", reason: "no matching durable read and assembled snapshot for every snapshot request" };
}
