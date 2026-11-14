import assert from "node:assert/strict";
import test from "node:test";
import { check, hostCalls, parseStarts, unexplainedStarts } from "./host-change-check.mjs";

const instance = "i-0123456789abcdef0";
const at = (minutes) => new Date(Date.UTC(2026, 10, 12, 10, minutes));

test("a stop, start or reboot of the production node pages, other calls and nodes do not", () => {
  const event = (EventName, ResourceName, EventId) => ({ EventName, EventId, EventTime: at(0), Username: "someone", Resources: [{ ResourceName }] });
  const incidents = hostCalls([event("StopInstances", instance, "a"), event("RebootInstances", instance, "b"), event("DescribeInstances", instance, "c"), event("StopInstances", "i-other", "d")], instance);
  assert.deepEqual(
    incidents.map((i) => i.key),
    ["host-change:chalk:a", "host-change:chalk:b"],
  );
});

test("a start during an open deploy record is explained, any other start pages", () => {
  const starts = [
    { time: at(20), previousBootEnd: "" },
    { time: at(59), previousBootEnd: "killed" },
  ];
  const incidents = unexplainedStarts(starts, [{ created: at(5), finished: null }]);
  assert.equal(incidents.length, 1);
  assert.match(incidents[0].detail, /Previous boot ended: killed/);
});

test("a completed deploy explains starts only until it finished", () => {
  const deployment = { created: at(5), finished: at(16) };
  const during = [
    { time: at(10), previousBootEnd: "" },
    { time: at(17), previousBootEnd: "" },
  ];
  assert.equal(unexplainedStarts(during, [deployment]).length, 0);
  assert.equal(unexplainedStarts([{ time: at(25), previousBootEnd: "killed" }], [deployment]).length, 1);
});

test("Axiom start rows parse and a malformed table is refused", () => {
  const body = { tables: [{ fields: [{ name: "_time" }, { name: "previous_boot_end" }], columns: [[at(1).toISOString()], ["clean"]] }] };
  assert.equal(parseStarts(body)[0].previousBootEnd, "clean");
  assert.throws(() => parseStarts({ tables: [] }), /malformed/);
});

test("the check posts to Oncall and fails the run when something paged", async () => {
  const posts = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("axiom")) return { ok: true, json: async () => ({ tables: [{ fields: [{ name: "_time" }], columns: [[new Date(Date.UTC(2026, 10, 12, 10, 55)).toISOString()]] }] }) };
    if (url.includes("/statuses")) return { ok: true, json: async () => [{ state: "success", created_at: at(40).toISOString() }] };
    if (url.includes("github")) {
      const records = [
        { id: 7, task: "production-release", created_at: at(30).toISOString() },
        { id: 8, task: "other", created_at: at(54).toISOString() },
      ];
      return { ok: true, json: async () => records };
    }
    posts.push(JSON.parse(init.body));
    return { ok: true };
  };
  const awsImpl = async () => JSON.stringify({ Events: [] });
  const env = { ONCALL_WEBHOOK_URL: "https://oncall.test", CHALK_AXIOM_QUERY_TOKEN: "t", CHALK_AXIOM_LOG_DATASET: "d", PRODUCTION_INSTANCE_ID: instance, GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r" };
  assert.equal(await check({ env, fetchImpl, awsImpl, now: at(60), log: () => {} }), 1);
  assert.equal(posts[0].incidents[0].app, "chalk");
});

test("a refused Axiom query reports its error code and never the provider's text", async () => {
  const fetchImpl = async (url) => (url.includes("axiom") ? { ok: false, status: 400, json: async () => ({ code: "bad_request", message: "unable to find dataset 'private-name'" }) } : { ok: true, json: async () => [] });
  const env = { ONCALL_WEBHOOK_URL: "https://oncall.test", CHALK_AXIOM_QUERY_TOKEN: "t", CHALK_AXIOM_LOG_DATASET: "d", PRODUCTION_INSTANCE_ID: instance, GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r" };
  const failure = await check({ env, fetchImpl, awsImpl: async () => JSON.stringify({ Events: [] }), now: at(60), log: () => {} }).catch((error) => error);
  assert.match(failure.message, /HTTP 400: bad_request$/);
  assert.doesNotMatch(failure.message, /private-name/);
});

test("a start from seven hours ago still pages, because GitHub can leave that long between runs", async () => {
  const start = new Date(at(60).getTime() - 7 * 60 * 60 * 1000);
  const queries = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("axiom")) {
      queries.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ tables: [{ fields: [{ name: "_time" }], columns: [[start.toISOString()]] }] }) };
    }
    if (url.includes("github")) return { ok: true, json: async () => [] };
    return { ok: true };
  };
  const env = { ONCALL_WEBHOOK_URL: "https://oncall.test", CHALK_AXIOM_QUERY_TOKEN: "t", CHALK_AXIOM_LOG_DATASET: "d", PRODUCTION_INSTANCE_ID: instance, GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r" };
  assert.equal(await check({ env, fetchImpl, awsImpl: async () => JSON.stringify({ Events: [] }), now: at(60), log: () => {} }), 1);
  assert.ok(new Date(queries[0].startTime) <= start, "the query window reaches back past the start");
});
