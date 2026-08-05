import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("App diagnostics wiring", () => {
  it("destructures and forwards the connection callback to the Space screen", () => {
    expect(source).toMatch(/function renderContent\(\{[\s\S]*?onDiagnosticsConnection,[\s\S]*?\}:\s*\{/u);
    expect(source).toContain("onDiagnosticsConnection={onDiagnosticsConnection}");
  });
});
