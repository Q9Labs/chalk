// @ts-check
import { correlation, finding, rows, sameRevision } from "./board-evidence.mjs";
export { applies } from "./board-evidence.mjs";

export const symptom = "board.edit_not_committed";
export const expected = "every submitted edit receives a matching durable Sync receipt and SDK commit";

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} input @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} */
export function decide({ readings }) {
  const client = rows(readings["board.client_edit"]);
  const sync = rows(readings["board.sync_edit"]);
  const failed = client.find((row) => row.claim === "store_failed" || row.claim === "refused");
  if (failed) {
    const local = failed.claim === "store_failed";
    const refusal = local ? undefined : sync.find((row) => row.claim === "refused" && correlation(row) === correlation(failed));
    return finding(
      failed,
      local ? "local_store" : "submit",
      local ? "the SDK could not save the edit to its pending store" : `the SDK got a terminal edit refusal (${failed.value.board_failure ?? "unspecified"})`,
      "a successful receipt for this operation ID",
      refusal ? { row: refusal, text: "Sync refused the same edit" } : null,
    );
  }
  const committed = client.filter((row) => row.claim === "committed");
  const confirmed = new Set(committed
    .filter((receipt) => sync.some((row) => row.claim !== "refused" && correlation(row) === correlation(receipt) && sameRevision(row, receipt)))
    .map(correlation));
  if (confirmed.size > 0 && client.every((row) => confirmed.has(correlation(row)))) return { status: "pass" };
  return { status: "unknown", reason: "no matching SDK and durable Sync commit for every witnessed edit" };
}
