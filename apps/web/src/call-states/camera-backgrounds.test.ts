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
    const { stdout } = await promisify(execFile)(linux ? "xvfb-run" : process.execPath, linux ? ["-a", process.execPath, ...args] : args, { env: { ...process.env, ...(linux ? { CAMERA_EFFECTS_HEADFUL: "1" } : {}) }, timeout: 150_000, maxBuffer: 1024 * 1024 });
    console.log(stdout);
  } finally {
    await stop();
  }
}, 180_000);
