import type { V1CommandResult } from "@q9labsai/chalk-client";

// The fixture server has no Focus; every Focus command is acknowledged without a round trip.
const acknowledged = async () => ({ type: "ack", command_id: "fixture-focus", delivery: "original", outcome: "satisfied", revision: 1, state_digest: "fixture" }) as V1CommandResult;

export const fixtureFocusCommands = {
  stepAway: acknowledged,
  returnFromStepAway: acknowledged,
  allowOtherTabs: acknowledged,
  endAllowance: acknowledged,
};
