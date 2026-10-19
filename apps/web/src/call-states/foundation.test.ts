import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps the foundation journeys usable in the real call harness", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../scripts/verify-call-foundation.mjs", import.meta.url))], { timeout: 110_000 });
  expect(stdout).toContain("PASS: default Dark, persistent Light");
}, 120_000);
