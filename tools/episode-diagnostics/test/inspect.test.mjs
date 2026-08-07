import { describe, expect, it, afterEach } from "vitest";
import { createDiagnosticFixtureServer } from "../src/fixture-server.mjs";
import { inspectDiagnostic } from "../src/inspect.mjs";

describe("inspectDiagnostic", () => {
  let fixture;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("returns a bounded overview and resolves a focused operation", async () => {
    fixture = await createDiagnosticFixtureServer();
    const result = await inspectDiagnostic(fixture.reference("stalled", { kind: "op", id: "fixture-op-chat" }), { baseUrl: fixture.url, environment: fixture.environment, credential: fixture.credential });
    expect(result.kind).toBe("overview");
    expect(result.focus.id).toBe("fixture-op-chat");
    expect(result.snapshot.events).toBeUndefined();
    expect(result.availableQueries).toContain("events");
  });

  it("supports JSON paging and projection queries", async () => {
    fixture = await createDiagnosticFixtureServer();
    const page = await inspectDiagnostic(fixture.reference("stalled"), { baseUrl: fixture.url, environment: fixture.environment, credential: fixture.credential, query: "events", format: "json", limit: 1 });
    expect(page.kind).toBe("page");
    expect(page.page.events).toHaveLength(1);
    expect(page.page.hasMore).toBe(true);
    const graph = await inspectDiagnostic(fixture.reference("stalled"), { baseUrl: fixture.url, environment: fixture.environment, credential: fixture.credential, query: "graph", format: "json" });
    expect(graph.projection.schemaVersion).toBe("GraphProjection/v1");
  });

  it("builds compact and copy-all brief outputs", async () => {
    fixture = await createDiagnosticFixtureServer();
    const compact = await inspectDiagnostic(fixture.reference("stalled"), { baseUrl: fixture.url, environment: fixture.environment, credential: fixture.credential, format: "agent" });
    expect(compact.kind).toBe("brief");
    expect(compact.text).toContain("AgentBrief/v1");
    const markdown = await inspectDiagnostic(fixture.reference("stalled"), { baseUrl: fixture.url, environment: fixture.environment, credential: fixture.credential, query: "copy-all" });
    expect(markdown.markdown).toContain("Episode Diagnostic Agent Brief");
  });

  it("renders copy-all from structured brief fields instead of server Markdown", async () => {
    const reference = "chalkdiag:v1:localhost:fixture-stalled";
    const brief = {
      schemaVersion: "AgentBrief/v1",
      version: 1,
      reference,
      captureTime: "2026-08-04T10:00:00.000Z",
      observedSummary: "Safe structured summary",
      environment: "localhost",
      resolverCommand: `pnpm trace:inspect ${reference} --format agent`,
      releaseCommits: [],
      visibleGaps: [],
      counts: { events: 1, operations: 0, issues: 0, openIssues: 0 },
      omissions: ["credentials omitted"],
    };
    const client = {
      config: { environment: "localhost" },
      brief: async () => ({ body: { schemaVersion: "AgentBriefResponse/v1", format: "markdown", brief, markdown: "password=secret token=secret credential=secret" }, status: 200, url: "https://chalk.test/brief" }),
    };

    const result = await inspectDiagnostic(reference, { query: "copy-all", client });

    expect(result.markdown).toContain("Safe structured summary");
    expect(result.markdown).not.toContain("password=secret");
    expect(result.markdown).not.toContain("token=secret");
    expect(result.markdown).not.toContain("credential=secret");
  });

  it.each([
    ["chalkdiag:v1:development:fixture-stalled", "cross_environment"],
    ["chalkdiag:v1:localhost:fixture-expired", "expired"],
    ["chalkdiag:v1:localhost:fixture-ambiguous", "ambiguous"],
  ])("fails closed for %s", async (reference, code) => {
    fixture = await createDiagnosticFixtureServer();
    await expect(inspectDiagnostic(reference, { baseUrl: fixture.url, environment: "localhost", credential: fixture.credential })).rejects.toMatchObject({ code });
  });

  it("maps an unauthorized operator to a nonzero typed error", async () => {
    fixture = await createDiagnosticFixtureServer();
    await expect(inspectDiagnostic(fixture.reference("stalled"), { baseUrl: fixture.url, environment: fixture.environment, credential: "wrong-operator" })).rejects.toMatchObject({ code: "unauthorized", exitCode: 3 });
  });
});
