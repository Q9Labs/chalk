import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STATES, createDiagnosticFixtureServer, fixtureSnapshot } from "../src/fixture-server.mjs";

const EXPECTED_STATUS_BY_STATE = Object.freeze({ "permission-denied": 403, error: 503, failed: 500 });

function fixtureProbeQuery(state) {
  return state === "loading" ? "?fixture_mode=probe" : "";
}

function expectedFixtureStatus(state) {
  return EXPECTED_STATUS_BY_STATE[state] ?? 200;
}

describe("diagnostic API fixture states", () => {
  let fixture;

  afterEach(async () => {
    await fixture?.close();
  });

  it("has a sanitized snapshot contract for every named state", () => {
    for (const state of FIXTURE_STATES) {
      const snapshot = fixtureSnapshot(state);
      expect(snapshot.schemaVersion).toBe("DiagnosticSnapshot/v1");
      expect(snapshot.reference).toContain(`fixture-${state}`);
      expect(snapshot.capturedAt).toBe("2026-08-04T00:00:00.000Z");
    }
  });

  it("serves every named API state with explicit failure semantics", async () => {
    fixture = await createDiagnosticFixtureServer();
    const headers = { authorization: `Bearer ${fixture.credential}` };
    for (const state of FIXTURE_STATES) {
      const probe = fixtureProbeQuery(state);
      const response = await fetch(`${fixture.url}/_internal/episode-diagnostics/${encodeURIComponent(fixture.reference(state))}${probe}`, { headers });
      expect(response.status, state).toBe(expectedFixtureStatus(state));
    }
  });

  it("serves empty, permission-denied, and loading probe states", async () => {
    fixture = await createDiagnosticFixtureServer();
    const headers = { authorization: `Bearer ${fixture.credential}` };
    const empty = await fetch(`${fixture.url}/_internal/episode-diagnostics/${encodeURIComponent(fixture.reference("empty"))}`, { headers });
    const emptyBody = await empty.json();
    expect(empty.status).toBe(200);
    expect(emptyBody.snapshot.summary.eventCount).toBe(0);
    expect(emptyBody.snapshot.filterFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const denied = await fetch(`${fixture.url}/_internal/episode-diagnostics/${encodeURIComponent(fixture.reference("permission-denied"))}`, { headers });
    expect(denied.status).toBe(403);
    const loading = await fetch(`${fixture.url}/_internal/episode-diagnostics/${encodeURIComponent(fixture.reference("loading"))}?fixture_mode=probe`, { headers });
    expect(loading.status).toBe(200);
  });

  it("closes a disconnect stream with a refillable gap and exposes export outcomes", async () => {
    fixture = await createDiagnosticFixtureServer();
    const headers = { authorization: `Bearer ${fixture.credential}` };
    const stream = await fetch(`${fixture.url}/_internal/episode-diagnostics/${encodeURIComponent(fixture.reference("disconnected"))}/stream?after=5`, { headers });
    const streamText = await stream.text();
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(streamText).toContain('"refillRequired":true');
    const exportResponse = await fetch(`${fixture.url}/_internal/episode-diagnostics/${encodeURIComponent(fixture.reference("export-failed"))}/export-jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "ExportJobRequest/v1" }),
    });
    const exportJob = await exportResponse.json();
    expect(exportJob.state).toBe("failed");
    const runningResponse = await fetch(`${fixture.url}/_internal/episode-diagnostics/${encodeURIComponent(fixture.reference("export-in-progress"))}/export-jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "ExportJobRequest/v1" }),
    });
    const runningJob = await runningResponse.json();
    expect(runningJob.state).toBe("running");
  });

  it("emits a compact snapshot refresh directive on the live stream", async () => {
    fixture = await createDiagnosticFixtureServer();
    const headers = { authorization: `Bearer ${fixture.credential}` };
    const reference = encodeURIComponent(fixture.reference("live"));
    const stream = await fetch(`${fixture.url}/_internal/episode-diagnostics/${reference}/stream?after=10`, { headers });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    try {
      while (!body.includes("event: heartbeat")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }

    expect(body).toContain('"kind":"gap"');
    expect(body).toContain('"reason":"snapshot_refresh"');
    expect(body).not.toContain('"snapshot"');
    expect(body).toContain('"schemaVersion":"DiagnosticStreamHeartbeat/v1"');
  });

  it("emits contract fingerprints for the real client filter and Events", async () => {
    fixture = await createDiagnosticFixtureServer();
    const headers = { authorization: `Bearer ${fixture.credential}` };
    const reference = encodeURIComponent(fixture.reference("live"));
    const eventsResponse = await fetch(`${fixture.url}/_internal/episode-diagnostics/${reference}/events?filters=${encodeURIComponent(JSON.stringify({ schemaVersion: "DiagnosticFilter/v1" }))}`, { headers });
    const eventsBody = await eventsResponse.json();
    expect(eventsResponse.status).toBe(200);
    expect(eventsBody.filterFingerprint).toBe("sha256:31a3c78b84f7ac3afc481943391cf66373e44a947f84979817a3f1b246c6b579");
    expect(eventsBody.events).toHaveLength(7);
    expect(eventsBody.events.map((event) => event.name)).toEqual(expect.arrayContaining(["participant.join", "chat.send", "reaction.send", "screen.start", "moderation.remove", "sync.reconnect"]));
    expect(eventsBody.events[0].fingerprint).not.toBe(`sha256:${"a".repeat(64)}`);
  });

  it("returns the AgentBrief format requested by the debugger", async () => {
    fixture = await createDiagnosticFixtureServer();
    const headers = { authorization: `Bearer ${fixture.credential}` };
    const briefUrl = `${fixture.url}/_internal/episode-diagnostics/${encodeURIComponent(fixture.reference("live"))}/brief`;

    const compact = await (await fetch(`${briefUrl}?format=compact`, { headers })).json();
    expect(compact).toMatchObject({ schemaVersion: "AgentBriefResponse/v1", format: "compact" });
    expect(compact.markdown).toBeUndefined();

    const markdown = await (await fetch(`${briefUrl}?format=markdown`, { headers })).json();
    expect(markdown).toMatchObject({ schemaVersion: "AgentBriefResponse/v1", format: "markdown" });
    expect(markdown.markdown).toContain("# Episode Diagnostic Agent Brief");
  });
});
