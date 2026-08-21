import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./prepare-pages-spa.mjs", import.meta.url), "utf8");
const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

describe("Cloudflare Pages SPA preparation", () => {
  it("preserves prerendered public pages and keeps a separate SPA shell", () => {
    expect(script).toContain("expected TanStack Start to prerender every public web page");
    expect(script).not.toContain("cpSync(shellPath, indexPath)");
    expect(script).toContain('const appShellUrl = "/_shell/"');
    expect(script).toContain("cpSync(shellPath, shellIndexPath)");
    expect(script).toContain("rmSync(shellPath)");
    expect(script).toContain("const APP_SHELL_URL = ${JSON.stringify(appShellUrl)}");
    expect(script).toContain('import { SITE_ORIGIN, SOCIAL_IMAGE_URL } from "../src/lib/site-head.ts"');
    expect(script).not.toContain("chalk-flow-hero-20260818.webp");
  });

  it("prerenders each public non-docs page to its canonical path", () => {
    expect(viteConfig).toContain("autoStaticPathsDiscovery: false");
    expect(viteConfig).toContain('maskPath: "/space"');
    expect(viteConfig).toContain('{ path: "/", prerender: { outputPath: "/index.html" } }');
    expect(viteConfig).toContain('{ path: "/status", prerender: { outputPath: "/status/index.html" } }');
    expect(viteConfig).toContain('{ path: "/privacy", prerender: { outputPath: "/privacy/index.html" } }');
    expect(viteConfig).toContain('{ path: "/terms", prerender: { outputPath: "/terms/index.html" } }');
  });

  it("caches successful navigation responses under their own request", () => {
    expect(script).toContain("await writeToCache(request, response.clone())");
    expect(script).not.toContain("await writeToCache(APP_SHELL_URL, response.clone())");
    expect(script).toContain("(await readFromCache(request)) ?? (await readFromCache(APP_SHELL_URL))");
  });
});
