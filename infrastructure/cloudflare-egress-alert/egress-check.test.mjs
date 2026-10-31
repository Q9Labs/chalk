import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, oncallPayload, readEgress, run } from "./egress-check.mjs";

const GB = 1e9;
const quiet = { dayBytes: 5 * GB, monthBytes: 100 * GB, dayStartsInMonth: true };

test("stays silent below every limit", () => {
  assert.deepEqual(evaluate(quiet), []);
});

test("fires the daily alert at 100 GB in 24 h", () => {
  const [incident] = evaluate({ ...quiet, dayBytes: 100 * GB });
  assert.equal(incident.key, "cloudflare-sfu-turn-egress-24h");
});

test("fires a monthly alert only on the run that crosses it", () => {
  const crossing = evaluate({ dayBytes: 30 * GB, monthBytes: 510 * GB, dayStartsInMonth: true });
  assert.deepEqual(
    crossing.map((i) => i.key),
    ["cloudflare-sfu-turn-egress-month-500gb"],
  );
  assert.deepEqual(evaluate({ dayBytes: 30 * GB, monthBytes: 540 * GB, dayStartsInMonth: true }), []);
});

test("fires both monthly alerts when one day crosses both", () => {
  const keys = evaluate({ dayBytes: 400 * GB, monthBytes: 850 * GB, dayStartsInMonth: true }).map((i) => i.key);
  assert.ok(keys.includes("cloudflare-sfu-turn-egress-24h"));
  assert.ok(keys.includes("cloudflare-sfu-turn-egress-month-500gb"));
  assert.ok(keys.includes("cloudflare-sfu-turn-egress-month-800gb"));
});

test("on the first of the month the whole month-to-date total is new", () => {
  const keys = evaluate({ dayBytes: 600 * GB, monthBytes: 600 * GB, dayStartsInMonth: false }).map((i) => i.key);
  assert.ok(keys.includes("cloudflare-sfu-turn-egress-month-500gb"));
});

test("payload follows the Oncall poller shape and marks drills", () => {
  const incidents = [{ key: "k", detail: "d" }];
  assert.deepEqual(oncallPayload(incidents, { drill: false }), {
    source: "oncall-poller",
    incidents: [{ app: "chalk", kind: "new", key: "k", detail: "d" }],
  });
  assert.equal(oncallPayload(incidents, { drill: true }).drill, true);
});

const graphql = (sfu, turn) => (url, init) => {
  if (url.includes("graphql")) {
    assert.match(init.headers.authorization, /^Bearer /);
    const groups = (bytes) => [{ sum: { egressBytes: bytes } }];
    const account = { daySfu: groups(sfu), dayTurn: groups(turn), monthSfu: groups(sfu), monthTurn: groups(turn) };
    return Response.json({ data: { viewer: { accounts: [account] } }, errors: null });
  }
  throw new Error(`unexpected request to ${url}`);
};

test("sums SFU and TURN egress", async () => {
  const usage = await readEgress({ fetchImpl: graphql(3 * GB, 1 * GB), accountId: "a", token: "t", now: new Date("2026-10-15T12:00:00Z") });
  assert.equal(usage.dayBytes, 4 * GB);
  assert.equal(usage.dayStartsInMonth, true);
});

test("fails loudly when Cloudflare returns errors", async () => {
  const fetchImpl = () => Response.json({ data: null, errors: [{ message: "denied" }] });
  await assert.rejects(readEgress({ fetchImpl, accountId: "a", token: "t", now: new Date() }), /no usage/);
});

const env = { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_ANALYTICS_TOKEN: "t", ONCALL_WEBHOOK_URL: "https://oncall.example/hook" };

test("run posts to Oncall and exits 1 when a limit is crossed", async () => {
  const posts = [];
  const fetchImpl = (url, init) => {
    if (url === env.ONCALL_WEBHOOK_URL) {
      posts.push(JSON.parse(init.body));
      return new Response("ok");
    }
    return graphql(150 * GB, 0)(url, init);
  };
  const code = await run({ env, fetchImpl, now: new Date("2026-10-15T12:00:00Z"), log: () => {} });
  assert.equal(code, 1);
  assert.equal(posts[0].incidents[0].key, "cloudflare-sfu-turn-egress-24h");
});

test("run stays silent and exits 0 below the limits", async () => {
  const fetchImpl = (url, init) => {
    assert.notEqual(url, env.ONCALL_WEBHOOK_URL);
    return graphql(1 * GB, 0)(url, init);
  };
  assert.equal(await run({ env, fetchImpl, log: () => {} }), 0);
});

test("a drill posts one marked test and exits 0", async () => {
  const posts = [];
  const fetchImpl = (url, init) => {
    if (url === env.ONCALL_WEBHOOK_URL) {
      posts.push(JSON.parse(init.body));
      return new Response("ok");
    }
    return graphql(1 * GB, 0)(url, init);
  };
  const code = await run({ env: { ...env, EGRESS_CHECK_DRILL: "true" }, fetchImpl, log: () => {} });
  assert.equal(code, 0);
  assert.equal(posts[0].drill, true);
});

test("a failed webhook post fails the run", async () => {
  const fetchImpl = (url, init) => (url === env.ONCALL_WEBHOOK_URL ? new Response("no", { status: 500 }) : graphql(150 * GB, 0)(url, init));
  await assert.rejects(run({ env, fetchImpl, log: () => {} }), /Oncall webhook answered HTTP 500/);
});

test("refuses to run without its inputs", async () => {
  await assert.rejects(run({ env: {}, log: () => {} }), /are required/);
});
