import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./prepare-pages-spa.mjs", import.meta.url), "utf8");

describe("Cloudflare Pages SPA preparation", () => {
  it("preserves prerendered public pages and keeps a separate SPA shell", () => {
    expect(script).toContain("expected TanStack Start to prerender every public web page");
    expect(script).not.toContain("cpSync(shellPath, indexPath)");
    expect(script).toContain('const APP_SHELL_URL = "/_shell.html"');
  });

  it("caches successful navigation responses under their own request", () => {
    expect(script).toContain("await writeToCache(request, response.clone())");
    expect(script).not.toContain("await writeToCache(APP_SHELL_URL, response.clone())");
    expect(script).toContain("(await readFromCache(request)) ?? (await readFromCache(APP_SHELL_URL))");
  });
});
