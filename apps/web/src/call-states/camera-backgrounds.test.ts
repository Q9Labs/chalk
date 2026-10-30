import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { startCallHarness } from "./browser-harness";

it("sends processed camera video and keeps the publication while choosing backgrounds", async () => {
  const { origin, stop } = await startCallHarness();
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../tests/camera-backgrounds-proof.mjs", import.meta.url)), origin], { env: process.env, timeout: 150_000, maxBuffer: 1024 * 1024 });
    console.log(stdout);
  } finally {
    await stop();
  }
}, 180_000);
