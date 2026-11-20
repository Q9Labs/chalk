// @ts-check
import { correlation, finding, revision, rows, sameRevision, scene } from "./board-evidence.mjs";
export { applies } from "./board-evidence.mjs";

export const symptom = "board.out_of_sync";
export const expected = "each recipient observes a contiguous board revision with the matching Sync socket push";

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} input @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} */
export function decide({ readings }) {
  const client = rows(readings["board.client_delivery"]);
  const sync = rows(readings["board.sync_delivery"]);
  const gap = client.find((row) => row.claim === "gap");
  if (gap) {
    const from = gap.value.board_previous_revision;
    const to = revision(gap);
    const missed =
      typeof from === "string" && typeof to === "string"
        ? sync.find((row) => {
            const rev = revision(row);
            return scene(row) === scene(gap) && typeof rev === "string" && BigInt(rev) > BigInt(from) && BigInt(rev) < BigInt(to);
          })
        : undefined;
    return finding(
      gap,
      "replica",
      `the SDK's board revision jumped from ${from} to ${to} in the same scene`,
      "the recipient had already applied the intervening revision in the same scene",
      missed ? { row: missed, text: `Sync pushed intervening revision ${revision(missed)} to a socket for this Participant` } : null,
    );
  }
  const pushes = new Map(sync.map((row) => [correlation(row), row]));
  const updates = new Map(client.map((row) => [correlation(row), row]));
  if (
    pushes.size > 0 &&
    pushes.size === updates.size &&
    [...updates].every(([id, row]) => {
      const push = pushes.get(id);
      return push && sameRevision(push, row);
    })
  )
    return { status: "pass" };
  return { status: "unknown", reason: "no matched SDK updates and Sync socket pushes for this recipient" };
}
