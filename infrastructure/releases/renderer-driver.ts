import stack, { stackName } from "../document-renderer/alchemy.run.ts";
import { parseInputs } from "../document-renderer/config.ts";
import { rendererPolicy } from "../document-renderer/policy.ts";
import { runDriver } from "./driver-run.ts";

await runDriver({
  name: "renderer",
  stackId: "document-renderer",
  stack,
  stackName,
  operations: ["noop", "release"],
  usage: "Usage: renderer-driver.ts <plan|noop|release> <production|nightly-run-id> [--apply]",
  parseInputs,
  policy: rendererPolicy,
  planOptions: { allowRecoverableInterruptedUpdate: true },
});
