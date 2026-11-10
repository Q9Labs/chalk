import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { startCallHarness } from "./browser-harness";

it("sends processed camera video and keeps the publication while choosing backgrounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-camera-browser-"));
  const xvfbLog = join(directory, "xvfb.log");
  try {
    const { origin, stop } = await startCallHarness();
    try {
      const args = [fileURLToPath(new URL("../../tests/camera-backgrounds-proof.mjs", import.meta.url)), origin];
      const linux = process.platform === "linux";
      try {
        const { stdout } = await promisify(execFile)(linux ? "xvfb-run" : process.execPath, linux ? ["-a", `--error-file=${xvfbLog}`, process.execPath, ...args] : args, { env: { ...process.env, ...(linux ? { CAMERA_EFFECTS_HEADFUL: "1" } : {}) }, timeout: 150_000, maxBuffer: 1024 * 1024 });
        console.log(stdout);
      } catch (error) {
        console.error("Camera browser proof failed", error);
        if (error instanceof Error && "stdout" in error) console.error(error.stdout);
        if (error instanceof Error && "stderr" in error) console.error(error.stderr);
        if (linux) console.error("Xvfb log:", await readFile(xvfbLog, "utf8").catch((cause: unknown) => String(cause)));
        throw error;
      }
    } finally {
      await stop();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
