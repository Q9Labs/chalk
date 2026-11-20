// @ts-check
import { finding, rows } from "./board-evidence.mjs";
export { applies } from "./board-evidence.mjs";

export const symptom = "board.draw_denied";
export const expected = "an explicit draw-access observation explains whether the Participant may draw";

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} input @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} */
export function decide({ readings }) {
  const access = rows(readings["board.client_draw"]);
  const denied = access.find((row) => row.claim === "denied");
  if (denied) {
    return finding(denied, "policy", "the SDK recorded a draw refusal for lack of permission", "a successful submission for this draw attempt", null, symptom);
  }
  if (access.some((row) => row.claim === "allowed" || row.claim === "blocked")) return { status: "pass" };
  return { status: "unknown", reason: "draw access was not observed" };
}
