import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMainModule } from "./main-module.js";

describe("isMainModule", () => {
  it("matches an entry started through a symlinked release directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chalk-main-module-")));
    mkdirSync(join(root, "releases", "r1"), { recursive: true });
    const script = join(root, "releases", "r1", "compose.js");
    writeFileSync(script, "");
    symlinkSync(join("releases", "r1"), join(root, "current"));

    expect(isMainModule(pathToFileURL(script).href, join(root, "current", "compose.js"))).toBe(true);
    expect(isMainModule(pathToFileURL(script).href, script)).toBe(true);
    expect(isMainModule(pathToFileURL(join(root, "other.js")).href, script)).toBe(false);
    expect(isMainModule(pathToFileURL(script).href, undefined)).toBe(false);
  });
});
