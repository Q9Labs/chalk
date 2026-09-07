import { defineGate, lanes } from "@q9labsai/gates";

export default defineGate({
  workspaceRoots: ["apps", "packages", "sdks/typescript"],
  concurrency: 1,
  lanes: [lanes.depcruise({ source: "." })],
});
