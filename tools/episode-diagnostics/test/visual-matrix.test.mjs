import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_CLOCK, VISUAL_VIEWPORTS } from "../src/fixture-server.mjs";
import { requireDebuggerURL, resolveDebuggerURL, runVisualMatrix, VISUAL_STATES } from "../src/visual-matrix.mjs";
import { runEpisodeDiagnosticBrowserProof } from "../src/browser-proof.mjs";

describe("diagnostic visual matrix", () => {
  it("captures every debugger view at the canonical first-state viewport", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "chalk-episode-debugger-views-"));
    const screenshots = [];
    try {
      const result = await runVisualMatrix({
        debuggerUrl: "http://localhost:8787/debugger?reference={reference}",
        outputDir,
        states: ["error", "reconnecting"],
        viewports: [1440],
        pageFactory: async () => ({
          async setViewportSize() {},
          async goto() {},
          async evaluate(callback) {
            const source = String(callback);
            if (source.includes("episodeDiagnosticsFixedClock")) return { fixedClock: FIXTURE_CLOCK, fontReady: true, dataReady: true };
            if (source.includes("unlabeledControls"))
              return {
                root: true,
                rootName: "main",
                streamState: "live",
                views: { Run: true, Graph: true, Trace: true, Flame: true, Issues: true, Participants: true, Epilogue: true },
                actions: { "copy-agent": true, "copy-all": true, "download-json": true, reconnect: true, gap: true },
                accessibility: { rootNamed: true, unlabeledControls: 0, lang: "en" },
              };
            return true;
          },
          async screenshot(options) {
            screenshots.push(options.path);
          },
          async close() {},
        }),
      });

      expect(result.results[0].views.screenshotPaths).toHaveLength(7);
      expect(result.results[1].views.screenshotPaths).toHaveLength(0);
      expect(screenshots).toHaveLength(9);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("covers named states and desktop widths with fixed readiness", async () => {
    const result = await runVisualMatrix({
      debuggerUrl: "http://localhost:8787/debugger?reference={reference}",
      screenshot: false,
      pageFactory: async (entry) => ({
        async setViewportSize() {},
        async goto() {},
        async evaluate(callback) {
          const source = String(callback);
          if (source.includes("episodeDiagnosticsFixedClock")) return { fixedClock: FIXTURE_CLOCK, fontReady: true, dataReady: true };
          if (source.includes("unlabeledControls"))
            return {
              root: true,
              rootName: "main",
              streamState: "live",
              views: { Run: true, Graph: true, Trace: true, Flame: true, Issues: true, Participants: true, Epilogue: true },
              actions: { "copy-agent": true, "copy-all": true, "download-json": true, reconnect: true, gap: true },
              accessibility: { rootNamed: true, unlabeledControls: 0, lang: "en" },
            };
          return true;
        },
        async close() {},
      }),
    });
    expect(result.clock).toBe(FIXTURE_CLOCK);
    expect(result.results).toHaveLength(VISUAL_STATES.length * VISUAL_VIEWPORTS.length);
    expect(result.results.map((item) => item.width)).toContain(1024);
    expect(result.results.map((item) => item.state)).toContain("export");
    expect(result.results.map((item) => item.state)).not.toContain("export-failed");
  });

  it("rejects a public URL in localhost mode and refuses fixture-only proof", async () => {
    expect(() => requireDebuggerURL("https://example.invalid/debugger", "localhost")).toThrow(/loopback/u);
    await expect(runVisualMatrix({ debuggerUrl: "http://localhost:8787" })).rejects.toThrow(/template/u);
    await expect(runEpisodeDiagnosticBrowserProof({ browser: {} })).rejects.toThrow(/debuggerUrl/u);
    expect(requireDebuggerURL("https://example.invalid/debugger", "development")).toContain("example.invalid");
  });

  it("resolves each named state through its canonical fixture reference", () => {
    const resolved = resolveDebuggerURL("http://localhost:8787/developer/episode-diagnostics/{reference}", "export-failed");
    expect(resolved).toContain("chalkdiag%3Av1%3Alocalhost%3Afixture-export-failed");
    expect(resolved).not.toContain("state=export-failed");
    expect(() => resolveDebuggerURL("http://localhost:8787/developer/episode-diagnostics", "live")).toThrow(/template/u);
  });
});
