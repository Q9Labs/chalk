import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const checkerPath = new URL("./check-tokenized-styles.mjs", import.meta.url);

describe("tokenized style checker", () => {
  it("rejects raw colors in runtime components", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "chalk-token-check-"));
    try {
      await mkdir(join(temporaryDirectory, "src"));
      await writeFile(join(temporaryDirectory, "src", "RuntimeSurface.tsx"), 'export const style = { color: "#ffffff" };\n');

      await expect(execFileAsync(process.execPath, [checkerPath.pathname], { cwd: temporaryDirectory })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("RuntimeSurface.tsx"),
      });
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
