import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps the call's radius and toast placement from the approved mockups", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../scripts/verify-call-mockup-parity.mjs", import.meta.url))], { timeout: 110_000 });
  expect(stdout).toContain("PASS: rounded fields, toasts above the board island, recordings keep their shape in the player");
}, 120_000);
