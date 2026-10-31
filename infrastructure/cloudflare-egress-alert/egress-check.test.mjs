import assert from "node:assert/strict";
import test from "node:test";
import { ALERT_KEYS, evaluate, oncallPayload, readEgress, run } from "./egress-check.mjs";

const GB = 1e9;
const quiet = { dayBytes: 5 * GB, monthBytes: 100 * GB, priorBytes: 95 * GB };

test("stays silent below every limit", () => {
  assert.deepEqual(evaluate(quiet), []);
});

test("fires the daily alert at 100 GB in 24 h", () => {
  const [incident] = evaluate({ ...quiet, dayBytes: 100 * GB });
  assert.equal(incident.key, "cloudflare-sfu-turn-egress:chalk:24h");
});

test("fires a monthly alert while its crossing is inside the lookback, then stops", () => {
  const keys = (usage) => evaluate({ dayBytes: 30 * GB, ...usage }).map((i) => i.key);
  const month500 = "cloudflare-sfu-turn-egress:chalk:month-500gb";
  assert.deepEqual(keys({ monthBytes: 510 * GB, priorBytes: 480 * GB }), [month500]);
  assert.deepEqual(keys({ monthBytes: 570 * GB, priorBytes: 480 * GB }), [month500], "still inside the lookback on a later run");
  assert.deepEqual(keys({ monthBytes: 600 * GB, priorBytes: 510 * GB }), [], "the crossing is older than the lookback");
});

test("a missed or failed run cannot hide a crossing", () => {
  // Crossed 500 GB two days ago and the runs since then missed or failed: the next run still sees it.
  const keys = evaluate({ dayBytes: 20 * GB, monthBytes: 560 * GB, priorBytes: 490 * GB }).map((i) => i.key);
  assert.deepEqual(keys, ["cloudflare-sfu-turn-egress:chalk:month-500gb"]);
});

test("fires both monthly alerts when one day crosses both", () => {
  const keys = evaluate({ dayBytes: 400 * GB, monthBytes: 850 * GB, priorBytes: 450 * GB }).map((i) => i.key);
  assert.ok(keys.includes("cloudflare-sfu-turn-egress:chalk:24h"));
  assert.ok(keys.includes("cloudflare-sfu-turn-egress:chalk:month-500gb"));
  assert.ok(keys.includes("cloudflare-sfu-turn-egress:chalk:month-800gb"));
});

test("early in the month the whole month-to-date total is new", () => {
  const keys = evaluate({ dayBytes: 600 * GB, monthBytes: 600 * GB, priorBytes: 0 }).map((i) => i.key);
  assert.ok(keys.includes("cloudflare-sfu-turn-egress:chalk:month-500gb"));
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
    const account = {
      daySfu: groups(sfu),
      dayTurn: groups(turn),
      monthSfu: groups(sfu),
      monthTurn: groups(turn),
      priorSfu: [],
      priorTurn: [],
    };
    return Response.json({ data: { viewer: { accounts: [account] } }, errors: null });
  }
  throw new Error(`unexpected request to ${url}`);
};

test("sums SFU and TURN egress", async () => {
  const usage = await readEgress({ fetchImpl: graphql(3 * GB, 1 * GB), accountId: "a", token: "t", now: new Date("2026-10-15T12:00:00Z") });
  assert.equal(usage.dayBytes, 4 * GB);
  assert.equal(usage.priorBytes, 0, "an empty prior window counts as 0");
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
  assert.equal(posts[0].incidents[0].key, "cloudflare-sfu-turn-egress:chalk:24h");
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

// Oncall's poller test pins these same three strings for Chalk's registered check.
test("alert keys are the ones Oncall registers for Chalk", () => {
  const expected = ["cloudflare-sfu-turn-egress:chalk:24h", "cloudflare-sfu-turn-egress:chalk:month-500gb", "cloudflare-sfu-turn-egress:chalk:month-800gb"];
  assert.deepEqual(ALERT_KEYS, expected);
  const crossed = evaluate({ dayBytes: 400 * GB, monthBytes: 850 * GB, priorBytes: 450 * GB });
  assert.deepEqual(
    crossed.map((i) => i.key),
    expected,
  );
});

test("a drill posts a key Oncall registers", async () => {
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
  assert.ok(ALERT_KEYS.includes(posts[0].incidents[0].key));
});

test("the query reads the month total as of the lookback", async () => {
  let variables;
  const fetchImpl = (url, init) => {
    variables = JSON.parse(init.body).variables;
    return graphql(1 * GB, 0)(url, init);
  };
  await readEgress({ fetchImpl, accountId: "a", token: "t", now: new Date("2026-10-15T12:00:00Z") });
  assert.equal(variables.priorEnd, "2026-10-12T12:00:00.000Z");
  assert.equal(variables.monthStart, "2026-10-01T00:00:00.000Z");
});

test("a drill posts even when Cloudflare analytics fails or is not configured", async () => {
  const posts = [];
  const fetchImpl = (url, init) => {
    if (url !== env.ONCALL_WEBHOOK_URL) throw new Error(`drill must not call ${url}`);
    posts.push(JSON.parse(init.body));
    return new Response("ok");
  };
  const code = await run({ env: { ONCALL_WEBHOOK_URL: env.ONCALL_WEBHOOK_URL, EGRESS_CHECK_DRILL: "true" }, fetchImpl, log: () => {} });
  assert.equal(code, 0);
  assert.equal(posts[0].drill, true);
});
