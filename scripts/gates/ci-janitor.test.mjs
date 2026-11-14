import assert from "node:assert/strict";
import test from "node:test";
import { janitor, plan } from "./ci-janitor.mjs";

const GIB = 1024 ** 3;
const now = new Date("2026-11-14T12:00:00Z");
const hoursAgo = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
let nextId = 1;
const cache = (ref, { gib = 0.5, accessed = 1 } = {}) => ({ id: nextId++, ref, key: `key-${nextId}`, size_in_bytes: gib * GIB, last_accessed_at: hoursAgo(accessed) });
const run = (caches, openPulls = [], budgetBytes) => plan({ caches, openPulls: new Set(openPulls), defaultRef: "refs/heads/master", now, budgetBytes });
const refsOf = (result) => result.deletions.map(({ cache: { ref } }) => ref);

test("caches of closed pull requests go, caches of open ones and of master stay", () => {
  const result = run([cache("refs/pull/10/merge"), cache("refs/pull/11/merge"), cache("refs/heads/master")], [11]);
  assert.deepEqual(refsOf(result), ["refs/pull/10/merge"]);
});

test("a merge queue cache goes after a day, a branch cache after three", () => {
  const result = run([cache("refs/heads/gh-readonly-queue/master/pr-1-a", { accessed: 25 }), cache("refs/heads/gh-readonly-queue/master/pr-2-b", { accessed: 2 }), cache("refs/heads/old", { accessed: 80 }), cache("refs/heads/new", { accessed: 70 })]);
  assert.deepEqual(refsOf(result), ["refs/heads/gh-readonly-queue/master/pr-1-a", "refs/heads/old"]);
});

test("over the budget, the least recently used non-master caches go first and master's never do", () => {
  const caches = [cache("refs/heads/master", { gib: 6, accessed: 500 }), cache("refs/pull/1/merge", { gib: 2, accessed: 30 }), cache("refs/pull/2/merge", { gib: 2, accessed: 5 })];
  const result = run(caches, [1, 2], 8 * GIB);
  assert.deepEqual(refsOf(result), ["refs/pull/1/merge"]);
  assert.equal(result.remainingBytes, 8 * GIB);
  const impossible = run([cache("refs/heads/master", { gib: 9 })], [], 8 * GIB);
  assert.deepEqual(impossible.deletions, []);
});

function fakeGithub({ caches, pulls }) {
  const calls = [];
  const fetchImpl = async (url, { method = "GET" } = {}) => {
    calls.push(`${method} ${url.replace("https://api.github.com/repos/", "")}`);
    const json = (body) => ({ ok: true, json: async () => body, text: async () => "" });
    if (method === "DELETE") return json(undefined);
    if (url.endsWith("/o/r")) return json({ default_branch: "master" });
    if (url.includes("/actions/caches")) return json({ actions_caches: caches });
    return json(pulls);
  };
  return { fetchImpl, calls };
}

test("the janitor deletes planned caches through the API, and a dry run deletes nothing", async () => {
  const caches = [cache("refs/pull/10/merge"), cache("refs/heads/master")];
  const live = fakeGithub({ caches, pulls: [] });
  const lines = [];
  await janitor({ env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, fetchImpl: live.fetchImpl, now, log: (line) => lines.push(line) });
  assert.deepEqual(live.calls.filter((call) => call.startsWith("DELETE")), [`DELETE o/r/actions/caches/${caches[0].id}`]);
  assert.match(lines.at(-1), /1 deletions/u);
  const dry = fakeGithub({ caches, pulls: [] });
  await janitor({ env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", CI_JANITOR_DRY_RUN: "true" }, fetchImpl: dry.fetchImpl, now, log: () => {} });
  assert.deepEqual(dry.calls.filter((call) => call.startsWith("DELETE")), []);
});

test("a failed GitHub call fails the run with the operation named", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "rate limited" });
  await assert.rejects(janitor({ env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, fetchImpl, now, log: () => {} }), /GET o\/r answered HTTP 403: rate limited/u);
});
