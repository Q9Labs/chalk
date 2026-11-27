import stack, { stackName } from "../transcription-dispatcher/alchemy.run.ts";
import { parseInputs } from "../transcription-dispatcher/config.ts";
import { dispatcherPolicy } from "../transcription-dispatcher/policy.ts";
import { runDriver } from "./driver-run.ts";

await runDriver({
  name: "dispatcher",
  stackId: "transcription-dispatcher",
  stack,
  stackName,
  operations: ["noop", "binding", "release", "mai"],
  usage: "Usage: driver.ts <plan|noop|binding|release|mai> <production|nightly-run-id> [--apply]",
  parseInputs,
  policy: dispatcherPolicy,
});
