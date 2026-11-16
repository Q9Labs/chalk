import { androidLogs } from "./android.mjs";
import { runChecked } from "./chalk-resources.mjs";
import { spawnCommand } from "../lib/platform.mjs";
try {
  await androidLogs({ run: runChecked, spawn: spawnCommand });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
