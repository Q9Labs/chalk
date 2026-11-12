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

test("a start within the lead time of a deploy record is explained, any other start pages", () => {
  const starts = [
    { time: at(20), previousBootEnd: "" },
    { time: at(59), previousBootEnd: "killed" },
  ];
  const incidents = unexplainedStarts(starts, [at(5)]);
  assert.equal(incidents.length, 1);
  assert.match(incidents[0].detail, /Previous boot ended: killed/);
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
    if (url.includes("github")) return { ok: true, json: async () => [] };
    posts.push(JSON.parse(init.body));
    return { ok: true };
  };
  const awsImpl = async () => JSON.stringify({ Events: [] });
  const env = { ONCALL_WEBHOOK_URL: "https://oncall.test", CHALK_AXIOM_QUERY_TOKEN: "t", CHALK_AXIOM_LOG_DATASET: "d", PRODUCTION_INSTANCE_ID: instance, GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r" };
  assert.equal(await check({ env, fetchImpl, awsImpl, now: at(60), log: () => {} }), 1);
  assert.equal(posts[0].incidents[0].app, "chalk");
});
