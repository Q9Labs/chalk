import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { waitForCredentialRefresh } from "./credential-refresh.mjs";

test("failed refresh hold retains each guest's counters, expiries and access status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-refresh-"));
  const refreshes = [
    { guest: 1, count: 1, initialExpiry: 100, latestExpiry: 200, requests: [{ status: 201 }] },
    { guest: 2, count: 0, initialExpiry: 100, latestExpiry: 0, requests: [{ status: 403, code: "access.forbidden" }] },
  ];
  const controller = new AbortController();
  controller.abort(new Error("hold interrupted"));
  try {
    await assert.rejects(
      waitForCredentialRefresh({ directory, signal: controller.signal }, refreshes, () => {}),
      /hold interrupted/,
    );
    assert.deepEqual(JSON.parse(await readFile(join(directory, "credential-refresh.json"), "utf8")), refreshes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readiness failure after refresh still retains the successful refresh evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-refresh-"));
  const refreshes = [{ count: 1, initialExpiry: 100, latestExpiry: 200 }];
  try {
    await assert.rejects(
      waitForCredentialRefresh({ directory, wait: async () => {} }, refreshes, () => {
        throw new Error("guest disconnected");
      }),
      /guest disconnected/,
    );
    assert.deepEqual(JSON.parse(await readFile(join(directory, "credential-refresh.json"), "utf8")), refreshes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
