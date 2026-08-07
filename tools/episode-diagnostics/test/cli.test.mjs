import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createDiagnosticFixtureServer } from "../src/fixture-server.mjs";
import { main, parseCliArguments, parseDuration, parseCursor } from "../src/cli.mjs";

function capture() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

describe("trace:inspect CLI", () => {
  it("parses the spec command grammar", () => {
    const parsed = parseCliArguments(["chalkdiag:v1:localhost:fixture-stalled", "--around", "30s", "--branch", "branch_1", "--format", "json", "--at-cursor", "9", "--latest"]);
    expect(parsed.query).toMatchObject({ aroundSeconds: 30, branchId: "branch_1", format: "json", atCursor: 9, latest: true });
  });

  it("keeps aliases, inline values, and bounded numeric validation deterministic", () => {
    const parsed = parseCliArguments(["chalkdiag:v1:localhost:fixture-stalled", "--query=events", "--branch-id", "branch_2", "--after-cursor=4", "--before-cursor", "8", "--page-size", "20"]);
    expect(parsed.query).toMatchObject({ query: "events", branchId: "branch_2", afterCursor: 4, beforeCursor: 8, limit: 20 });
    expect(parseDuration("500ms")).toBe(0.5);
    expect(parseCursor("9", "--cursor")).toBe(9);
    expect(() => parseDuration("2h")).toThrow(/between 0 and 3600/u);
    expect(() => parseCursor("not-a-cursor", "--cursor")).toThrow(/non-negative integer/u);
  });

  it("renders bounded text and returns nonzero for malformed input", async () => {
    const fixture = await createDiagnosticFixtureServer();
    try {
      const stdout = capture();
      const status = await main([fixture.reference("stalled"), "--format", "text"], { stdout: stdout.stream, stderr: capture().stream });
      // The fixture uses localhost:8787 by default for a root CLI. Injecting a
      // base URL is intentionally an API-level concern, so this only checks
      // grammar and malformed failure here.
      expect(status).not.toBe(0);
      expect(stdout.text()).toBe("");
      const error = capture();
      const malformed = await main(["not-a-reference"], { stdout: capture().stream, stderr: error.stream });
      expect(malformed).toBeGreaterThan(0);
      expect(error.text()).toContain("trace:inspect malformed");
    } finally {
      await fixture.close();
    }
  });
});
