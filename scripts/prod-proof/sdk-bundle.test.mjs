import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { baselineEntry } from "./leave-baseline.mjs";
import { buildSdkBundle } from "./sdk-bundle.mjs";

const currentClient = new URL("../../sdks/typescript/client/src/index.ts", import.meta.url).pathname;

async function withDirectory(body) {
  const directory = await mkdtemp(join(tmpdir(), "sdk-bundle-"));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// An older release exports createSpaceClient and nothing else the proofs added later. The Leave proof bundles it as the baseline.
test("the proof bundle builds against a client entry that has no preconnect export", () =>
  withDirectory(async (directory) => {
    const entry = join(directory, "old-client.mjs");
    await writeFile(entry, "export function createSpaceClient() { return { join: async () => {} }; }\n");
    assert.match(await buildSdkBundle(entry), /proofJoin/);
  }));

test("the proof bundle builds against a client entry that exports preconnect, with and without the lobby helper", () =>
  withDirectory(async (directory) => {
    const entry = join(directory, "new-client.mjs");
    await writeFile(entry, "export function createSpaceClient() { return { join: async () => {} }; }\nexport function preconnect() {}\n");
    assert.doesNotMatch(await buildSdkBundle(entry), /proofLobby/);
    assert.match(await buildSdkBundle(entry, { lobby: true }), /proofLobby/);
  }));

test("the proof bundle builds against the current client source, lobby helper included", async () => {
  assert.match(await buildSdkBundle(currentClient, { lobby: true }), /proofLobby/);
  assert.match(await buildSdkBundle(currentClient), /proofJoin/);
});

// The exact release the Leave proof compares against: fetched from npm and checked against its published integrity.
test("the proof bundle builds against the published Leave baseline client", () =>
  withDirectory(async (directory) => {
    const entry = await baselineEntry({ directory });
    assert.match(await buildSdkBundle(entry), /proofJoin/);
  }));
