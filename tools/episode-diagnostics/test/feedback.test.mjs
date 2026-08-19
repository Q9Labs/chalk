import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedbackClient } from "../src/feedback-client.mjs";
import { resolveFeedbackOperatorConfig, isAllowedObservabilityURL } from "../src/feedback-config.mjs";
import { writeFeedbackPull } from "../src/feedback-download.mjs";
import { openFeedbackReport } from "../src/feedback-open.mjs";
import { parseFeedbackEvidence, parseFeedbackReport } from "../src/feedback-parsers.mjs";
import { escapeTerminalControls } from "../src/feedback-render.mjs";
import { FEEDBACK_HELP, main, parseFeedbackCliArguments } from "../src/feedback-cli.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const TRACE_ID = "11111111111111111111111111111111";
const EVIDENCE = {
  schema_version: "FeedbackEvidence/v1",
  collected_at: "2026-08-19T00:00:00.000Z",
  sdk: { client: "0.1.0" },
  platform: { kind: "web" },
  correlations: { trace_id: TRACE_ID },
  diagnostics: { availability: "unavailable", dropped_count: 0, telemetry_events: [], diagnostic_events: [] },
  local_state: { registry_version: "FeedbackLocalState/v1", entries: [] },
  cookies: { registry_version: "FeedbackCookies/v1", entries: [] },
  screenshot: { state: "unavailable" },
};

function report(overrides = {}) {
  return {
    schema_version: "FeedbackReport/v1",
    id: ID,
    tenant_id: ID,
    category: "bug",
    source: "chalk_web",
    message: "The reconnect button is\u001b[31m red",
    submitter_kind: "account",
    correlations: { trace_id: TRACE_ID },
    evidence: { size: 2, sha256: "a".repeat(64), screenshot: false },
    created_at: "2026-08-19T00:00:00.000Z",
    submitted_at: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

function output() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
    },
    text() {
      return chunks.join("");
    },
  };
}

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Feedback operator CLI primitives", () => {
  it("parses the closed report and evidence contracts and rejects unknown fields", () => {
    expect(parseFeedbackReport(report()).id).toBe(ID);
    expect(() => parseFeedbackReport({ ...report(), unsafe: true })).toThrow(/unknown field/u);
    expect(parseFeedbackEvidence(EVIDENCE).schema_version).toBe("FeedbackEvidence/v1");
    expect(() => parseFeedbackEvidence({ ...EVIDENCE, unknown: true })).toThrow(/unknown field/u);
  });

  it("escapes terminal controls without changing JSON-safe values", () => {
    expect(escapeTerminalControls("ok\u001b[31m\u0007\nnext")).toBe("ok\\u001b[31m\\u0007\nnext");
  });

  it("uses the shared operator config and host allowlist for open", async () => {
    const config = await resolveFeedbackOperatorConfig({ baseUrl: "http://localhost:8787", environment: "localhost", credential: "fixture-op", observabilityHosts: ["obs.example.test"] });
    expect(config.observabilityHosts).toEqual(["obs.example.test"]);
    expect(isAllowedObservabilityURL("https://obs.example.test/developer/traces/1", config.observabilityHosts)).toBe(true);
    expect(isAllowedObservabilityURL("https://evil.example.test/developer/traces/1", config.observabilityHosts)).toBe(false);
    const opened = await openFeedbackReport(report({ correlations: { trace_id: TRACE_ID } }), { config: { ...config, observabilityOrigin: "https://obs.example.test" }, launch: false });
    expect(opened.url).toBe(`https://obs.example.test/developer/traces/${TRACE_ID}`);
  });

  it("downloads typed report objects and bounded evidence with checksum verification", async () => {
    const evidenceBytes = Buffer.from(JSON.stringify(EVIDENCE));
    const checksum = createHash("sha256").update(evidenceBytes).digest("hex");
    const detail = report({ evidence: { size: evidenceBytes.length, sha256: checksum, screenshot: false } });
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/evidence")) return new Response(evidenceBytes, { status: 200, headers: { "Content-Type": "application/json", "Content-Length": String(evidenceBytes.length), "Content-SHA256": checksum } });
      if (path.endsWith(`/${ID}`)) return Response.json(detail);
      return Response.json({ reports: [detail], has_more: false });
    };
    const client = await createFeedbackClient({ config: { baseUrl: "http://localhost:8787", environment: "localhost", credential: "fixture-op", fetchImpl, observabilityOrigin: "http://localhost:8787", observabilityHosts: ["localhost:8787"] } });
    expect((await client.list()).reports).toHaveLength(1);
    expect((await client.show(ID)).id).toBe(ID);
    expect((await client.evidence(ID)).sha256).toBe(checksum);
  });

  it("writes a unique pull directory without overwriting a non-empty path", async () => {
    const root = await mkdtemp(join(tmpdir(), "chalk-feedback-cli-"));
    temporaryDirectories.push(root);
    const evidenceBytes = Buffer.from(JSON.stringify(EVIDENCE));
    const evidenceChecksum = createHash("sha256").update(evidenceBytes).digest("hex");
    const result = await writeFeedbackPull({
      report: report({ evidence: { size: evidenceBytes.length, sha256: evidenceChecksum, screenshot: false } }),
      evidence: { bytes: evidenceBytes, size: evidenceBytes.length, sha256: evidenceChecksum, contentType: "application/json", url: "http://localhost/evidence" },
      cwd: root,
      output: "pull",
    });
    expect(result.files).toContain("manifest.json");
    expect(JSON.parse(await readFile(join(result.output, "manifest.json"))).schema_version).toBe("FeedbackPullManifest/v1");
    await expect(writeFeedbackPull({ report: report(), evidence: { bytes: evidenceBytes, size: evidenceBytes.length, sha256: evidenceChecksum, contentType: "application/json", url: "http://localhost/evidence" }, cwd: root, output: "pull" })).rejects.toMatchObject({ code: "unsafe_output" });
    expect(await readdir(result.output)).toContain("evidence.json");
  });

  it("atomically replaces an existing empty pull directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "chalk-feedback-cli-empty-"));
    temporaryDirectories.push(root);
    const outputPath = join(root, "pull");
    await mkdir(outputPath);
    const evidenceBytes = Buffer.from(JSON.stringify(EVIDENCE));
    const evidenceChecksum = createHash("sha256").update(evidenceBytes).digest("hex");

    const result = await writeFeedbackPull({
      report: report({ evidence: { size: evidenceBytes.length, sha256: evidenceChecksum, screenshot: false } }),
      evidence: { bytes: evidenceBytes, size: evidenceBytes.length, sha256: evidenceChecksum, contentType: "application/json", url: "http://localhost/evidence" },
      cwd: root,
      output: "pull",
    });

    expect(result.output).toBe(outputPath);
    expect(await readdir(outputPath)).toEqual(expect.arrayContaining(["evidence.json", "manifest.json"]));
  });

  it("keeps the trace interface separate and dispatches Feedback commands", async () => {
    expect(parseFeedbackCliArguments(["list", "--category", "bug", "--page-size", "10", "--format", "json"])).toMatchObject({ command: "list", options: { category: "bug", page_size: 10, format: "json" } });
    const stdout = output();
    const stderr = output();
    const fakeClient = {
      async list() {
        return { reports: [report()], has_more: false };
      },
    };
    expect(await main(["list"], { stdout, stderr }, { client: fakeClient })).toBe(0);
    expect(stdout.text()).toContain(ID);
    expect(stderr.text()).toBe("");
  });

  it("prints actionable help and rejects unknown options without consuming a value", async () => {
    const stdout = output();
    const stderr = output();
    expect(await main([], { stdout, stderr })).toBe(0);
    expect(stdout.text()).toBe(`${FEEDBACK_HELP}\n`);
    expect(stdout.text()).toContain("CHALK_EPISODE_DIAGNOSTICS_OPERATOR_TOKEN");
    expect(stdout.text()).toContain("non-empty directories are refused");

    const invalidStderr = output();
    expect(await main(["list", "--bogus"], { stdout: output(), stderr: invalidStderr })).toBe(2);
    expect(invalidStderr.text()).toBe("Unknown option --bogus\n");
  });
});
