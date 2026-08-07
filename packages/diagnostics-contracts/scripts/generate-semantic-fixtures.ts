import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_SET_V1 } from "../src/actions.ts";
import { buildSemanticFixtureSet, buildVerificationLedger } from "../src/semantic-fixtures.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = resolve(scriptDirectory, "../fixtures");
mkdirSync(fixturesDirectory, { recursive: true });

const actionOperations = ACTION_SET_V1.map(({ operation }) => operation);
const outputs = [
  { fileName: "action-success.v1.json", value: { schemaVersion: "EpisodeDiagnosticFixture/v1", kind: "success", operations: actionOperations, contentCaptured: false, whiteboard: "explicitly unsupported" } },
  { fileName: "action-failure.v1.json", value: { schemaVersion: "EpisodeDiagnosticFixture/v1", kind: "failure_or_gap", operations: actionOperations, missingConfirmation: "first required checkpoint is named", contentCaptured: false, whiteboard: "unsupported marker remains explicit" } },
  {
    fileName: "agent-brief-parity.v1.json",
    value: {
      schemaVersion: "AgentBrief/v1",
      version: 1,
      reference: "chalkdiag:v1:development:diag01@7",
      focusedReference: "chalkdiag:v1:development:diag01:issue:issue01@7",
      captureTime: "2026-08-04T00:00:00.000Z",
      selectedCursor: 7,
      observedSummary: "Chat send stalled at sender receipt.",
      environment: "development",
      resolverCommand: "pnpm trace:inspect chalkdiag:v1:development:diag01:issue:issue01@7 --format agent",
      releaseCommits: [{ release: "dev-2026.08.04", sourceCommit: "abc123" }],
      visibleGaps: [{ kind: "checkpoint", summary: "Sender receipt was not observable.", reason: "not_observable", firstCursor: 6 }],
      counts: { events: 7, operations: 1, issues: 1 },
      omissions: ["raw chat text", "raw provider payloads"],
    },
  },
  {
    fileName: "redaction-corpus.v1.json",
    value: {
      safe: { status: "committed", bytes: 64, retryable: false, size_bucket: "small" },
      forbidden: { message: "do not retain this chat text", displayName: "Participant name", token: "Bearer secret", url: "https://example.invalid/path", sdp: "v=0\\r\\n", candidate: "candidate:1 1 UDP 10.0.0.1", exception: { message: "private error" }, webhookBody: "private payload" },
    },
  },
  { fileName: "semantic-events.v1.json", value: buildSemanticFixtureSet() },
  { fileName: "verification-ledger.v1.json", value: buildVerificationLedger() },
] as const;

const render = (value: unknown): string => {
  const pretty = JSON.stringify(value, null, 2);
  return `${pretty.replace('  "omissions": [\n    "raw chat text",\n    "raw provider payloads"\n  ]', '  "omissions": ["raw chat text", "raw provider payloads"]')}\n`;
};
const checkOnly = process.argv.includes("--check");
const drift: string[] = [];

for (const output of outputs) {
  const filePath = resolve(fixturesDirectory, output.fileName);
  const expected = render(output.value);
  if (checkOnly) {
    let actual: string | undefined;
    try {
      actual = readFileSync(filePath, "utf8");
    } catch {
      actual = undefined;
    }
    if (actual !== expected) drift.push(output.fileName);
    continue;
  }
  writeFileSync(filePath, expected, "utf8");
}

if (drift.length > 0) {
  throw new Error(`generated fixture drift: ${drift.join(", ")}`);
}
