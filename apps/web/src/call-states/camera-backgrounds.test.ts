import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { startCallHarness } from "./browser-harness";

it("sends processed camera video and keeps the publication while choosing backgrounds", async () => {
  const { origin, stop } = await startCallHarness();
  try {
    const args = [fileURLToPath(new URL("../../tests/camera-backgrounds-proof.mjs", import.meta.url)), origin];
    const linux = process.platform === "linux";
    try {
      const { stdout } = await promisify(execFile)(linux ? "xvfb-run" : process.execPath, linux ? ["-a", "--error-file=/dev/stderr", process.execPath, ...args] : args, { env: { ...process.env, ...(linux ? { CAMERA_EFFECTS_HEADFUL: "1" } : {}) }, timeout: 150_000, maxBuffer: 1024 * 1024 });
      console.log(stdout);
    } catch (error) {
      console.error("Camera browser proof failed", error);
      if (error instanceof Error && "stdout" in error) console.error(error.stdout);
      if (error instanceof Error && "stderr" in error) console.error(error.stderr);
      throw error;
    }
  } finally {
    await stop();
  }
}, 180_000);
