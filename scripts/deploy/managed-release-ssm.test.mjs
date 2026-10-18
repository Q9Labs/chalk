import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureDocumentVersion } from "./managed-release-ssm.mjs";

const observedResponse = JSON.parse(await readFile(new URL("./fixtures/ssm-get-document.nightly.json", import.meta.url), "utf8"));

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "chalk-ssm-content-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const content = await readFile(new URL("./fixtures/managed-release-document.json", import.meta.url), "utf8");
  const path = join(directory, "document.json");
  await writeFile(path, content);
  return { content, document: { path, format: "JSON", versionName: "controller-v2-3241b6227e0a0e88" } };
}

function provider(content, { status = observedResponse.Status, version = observedResponse.DocumentVersion, versionName, readError } = {}) {
  const calls = [];
  return {
    calls,
    commandRunner: async ({ args }) => {
      const operation = args[4];
      calls.push(operation);
      const responses = {
        "list-document-versions": { DocumentVersions: [{ DocumentVersion: observedResponse.DocumentVersion, Status: observedResponse.Status, VersionName: versionName }] },
        "get-document": { ...observedResponse, DocumentVersion: version, Status: status, Content: content },
        "update-document": { DocumentDescription: { DocumentVersion: "2" } },
        "describe-document": { Document: { Status: "Active" } },
      };
      assert.ok(Object.hasOwn(responses, operation), `Unexpected provider operation: ${operation}`);
      if (operation === "get-document" && readError) throw readError;
      return { stdout: JSON.stringify(responses[operation]) };
    },
  };
}

async function ensure(document, boundary) {
  return ensureDocumentVersion({ ...boundary, document, documentName: "fixture", region: "fixture", sleep: async () => {} });
}

test("reuses identical provider content without publishing a duplicate unnamed version", async (context) => {
  const { content, document } = await fixture(context);
  assert.deepEqual(JSON.parse(observedResponse.Content), JSON.parse(content));
  assert.equal(Object.hasOwn(observedResponse, "VersionName"), false);
  for (const bytes of [observedResponse.Content, JSON.stringify(JSON.parse(observedResponse.Content), null, 2)]) {
    const boundary = provider(bytes);
    assert.equal(await ensure(document, boundary), "1");
    assert.deepEqual(boundary.calls, ["list-document-versions", "get-document"]);
  }
});

test("publishes changed content and waits for its numeric version to be active", async (context) => {
  const { content, document } = await fixture(context);
  const previous = { ...JSON.parse(content), description: "Previous managed deployment instructions" };
  const boundary = provider(JSON.stringify(previous));
  assert.equal(await ensure(document, boundary), "2");
  assert.deepEqual(boundary.calls, ["list-document-versions", "get-document", "update-document", "describe-document"]);
});

test("does not mutate after a failed provider content read", async (context) => {
  const { content, document } = await fixture(context);
  const boundary = provider(content, { readError: new Error("AccessDenied") });
  await assert.rejects(ensure(document, boundary), /AccessDenied/);
  assert.deepEqual(boundary.calls, ["list-document-versions", "get-document"]);
});

test("rejects unpinned or failed matching provider versions", async (context) => {
  const { content, document } = await fixture(context);
  for (const [metadata, message] of [
    [{ version: "$LATEST" }, /pinned numeric/],
    [{ status: "Failed" }, /entered Failed/],
  ]) {
    const boundary = provider(content, metadata);
    await assert.rejects(ensure(document, boundary), message);
    assert.deepEqual(boundary.calls, ["list-document-versions", "get-document"]);
  }
});

test("keeps reuse of an already named controller version unchanged", async (context) => {
  const { content, document } = await fixture(context);
  const boundary = provider(content, { versionName: document.versionName, readError: new Error("should not read") });
  assert.equal(await ensure(document, boundary), "1");
  assert.deepEqual(boundary.calls, ["list-document-versions"]);
});
