import { fileURLToPath } from "node:url";
import { installLocalApk } from "./dev/android.mjs";
import { runChecked } from "./dev/chalk-resources.mjs";
try {
  await installLocalApk(process.argv.slice(2), { root: fileURLToPath(new URL("..", import.meta.url)), run: runChecked });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
