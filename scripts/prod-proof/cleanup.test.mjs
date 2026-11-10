import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { cleanupByRunId } from "./cleanup.mjs";

const config = { api_url: "https://api.invalid", web_url: "https://web.invalid", api_key: "chalk_sk_test", tenant_id: "tenant-1" };
const scratchDirs = [];
const scratch = async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-cleanup-test-"));
  scratchDirs.push(directory);
  return directory;
};
after(() => Promise.all(scratchDirs.map((directory) => rm(directory, { recursive: true, force: true }))));
const emptyListing = () => Response.json({ spaces: [], pagination: { next_cursor: "" } });

async function withFetch(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("a connection reset during remote cleanup is retried and cleanup passes", async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
    return emptyListing();
  };
  const results = await withFetch(fake, async () => cleanupByRunId(config, "run-reset", await scratch()));
  assert.equal(calls, 2);
  assert.ok(results.every((result) => result.result !== "failed"));
});

test("a connection that keeps resetting still fails cleanup after three tries", async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
  };
  await assert.rejects(
    withFetch(fake, async () => cleanupByRunId(config, "run-down", await scratch())),
    /Remote cleanup failed/,
  );
  assert.equal(calls, 3);
});

test("cleanup ends an Episode the run created in a Space it does not own", async () => {
  const directory = await scratch();
  await writeFile(join(directory, "ownership.json"), JSON.stringify({ episodes: [{ space_id: "pinned", id: "e1" }] }));
  const calls = [];
  let ended = false;
  const fake = async (url, init = {}) => {
    const { pathname } = new URL(url);
    calls.push(`${init.method ?? "GET"} ${pathname}`);
    if (pathname.endsWith("/episodes/e1/end")) {
      ended = true;
      return Response.json({});
    }
    if (pathname.endsWith("/episodes/e1")) return Response.json({ id: "e1", status: ended ? "ended" : "active" });
    return emptyListing();
  };
  await withFetch(fake, () => cleanupByRunId(config, "run-pinned", directory));
  assert.ok(calls.includes("POST /v1/tenants/tenant-1/spaces/pinned/episodes/e1/end"));
});
