import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EPISODE_THRESHOLD, SIGNALS, evaluate, mergeEpisodes, oncallPayload, parseTabular, query, readSignals, run } from "./listener-audio-check.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./testdata/${name}.json`, import.meta.url), "utf8"));
const id = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-31T12:00:00Z");
const window = { startTime: "2026-10-31T11:50:00.000Z", endTime: now.toISOString() };
const env = { CHALK_AXIOM_QUERY_TOKEN: "fake-token", CHALK_AXIOM_LOG_DATASET: "synthetic-private-dataset", ONCALL_WEBHOOK_URL: "https://example.invalid/oncall" };
const ok = (body) => ({ ok: true, json: async () => body });

test("parses recorded-shape empty, one and several Episode tables by field name", async () => {
  assert.deepEqual(parseTabular(await fixture("empty")), []);
  assert.deepEqual(parseTabular(await fixture("one")), [{ episode_id: id, signal: "api_unpulled", events: 1 }]);
  const rows = parseTabular(await fixture("several"));
  assert.equal(rows.length, 3);
  const merged = mergeEpisodes(rows);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].counts, { api_unpulled: 1, synthetic_second: 2 });
  assert.equal(merged[0].total, 3);
  assert.equal(evaluate(rows, window).length, 2);
  assert.deepEqual(mergeEpisodes([]), []);
  assert.deepEqual(mergeEpisodes([{ episode_id: "injection", signal: "api_unpulled", events: 1 }]), []);
  assert.deepEqual(mergeEpisodes([...rows, rows[0]])[0].counts, { api_unpulled: 2, synthetic_second: 2 });
});

test("rejects malformed, partial and invalid events results without leaking body", async () => {
  const one = await fixture("one");
  for (const body of [null, {}, { tables: [] }, await fixture("malformed"), { ...one, status: { isPartial: true } }, { ...one, status: { isEstimate: true } }]) {
    assert.throws(() => parseTabular(body), /malformed tabular/);
  }
  for (const events of [-1, 1.5, "1", null]) {
    const body = structuredClone(one);
    body.tables[0].columns[2][0] = events;
    assert.throws(() => parseTabular(body), /malformed tabular/);
  }
});

test("threshold is one; stable Episode keys merge signals across overlapping windows", () => {
  assert.equal(EPISODE_THRESHOLD, 1);
  assert.deepEqual(evaluate([{ episode_id: id, signal: "api_unpulled", events: 0 }], window), []);
  const rows = [
    { episode_id: id, signal: "api_unpulled", events: 1 },
    { episode_id: id.toUpperCase(), signal: "synthetic_second", events: 2 },
  ];
  const first = evaluate(rows, window);
  const second = evaluate(rows, { startTime: "2026-10-31T11:55:00.000Z", endTime: "2026-10-31T12:05:00.000Z" });
  assert.equal(first.length, 1);
  assert.equal(first[0].key, `listener-audio:chalk:${id}`);
  assert.equal(first[0].key, second[0].key);
  assert.match(first[0].detail, /api_unpulled: 1, synthetic_second: 2/);
  assert.ok(first[0].detail.includes(window.startTime));
  assert.ok(first[0].detail.includes(window.endTime));
});

test("posts exact payload, requests a ten-minute APL window and logs aggregates only", async () => {
  const calls = [],
    logs = [];
  const result = await run({
    env,
    now,
    log: (s) => logs.push(s),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? ok(await fixture("several")) : ok({});
    },
  });
  assert.equal(result, 1);
  assert.equal(calls[0].url, "https://api.axiom.co/v1/datasets/_apl?format=tabular");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.authorization, "Bearer fake-token");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, { apl: query(env.CHALK_AXIOM_LOG_DATASET), ...window });
  assert.equal(new Date(body.endTime) - new Date(body.startTime), 600000);
  assert.ok(body.apl.includes(env.CHALK_AXIOM_LOG_DATASET));
  assert.ok(body.apl.includes("media.listener_publication_unpulled"));
  assert.match(body.apl, /project episode_id, signal, events$/);
  assert.doesNotMatch(body.apl, /participant|publication_id|tenant|space|sdk.connection_report/);
  assert.deepEqual(SIGNALS, [{ name: "api_unpulled", event: "media.listener_publication_unpulled" }]);
  assert.equal(calls[1].url, env.ONCALL_WEBHOOK_URL);
  const payload = JSON.parse(calls[1].options.body);
  assert.deepEqual(payload, oncallPayload(evaluate(parseTabular(await fixture("several")), window), { drill: false }));
  assert.deepEqual(Object.keys(payload).sort(), ["incidents", "source"]);
  assert.equal(payload.source, "oncall-poller");
  assert.equal(payload.incidents[0].app, "chalk");
  assert.equal(payload.incidents[0].kind, "new");
  assert.deepEqual(logs, ["2 Episodes affected, 6 events"]);
  assert.doesNotMatch(logs.join(""), /[a-f0-9]{8}-[a-f0-9-]{27,}|[a-f0-9]{32,}|synthetic-private-dataset|participant|publication/i);
});

test("empty result succeeds without webhook", async () => {
  let calls = 0;
  const logs = [];
  assert.equal(
    await run({
      env,
      now,
      log: (s) => logs.push(s),
      fetchImpl: async () => {
        calls++;
        return ok(await fixture("empty"));
      },
    }),
    0,
  );
  assert.equal(calls, 1);
  assert.deepEqual(logs, ["0 Episodes affected, 0 events"]);
});

test("drill needs only webhook, never reads Axiom, and succeeds", async () => {
  const calls = [],
    logs = [];
  assert.equal(
    await run({
      env: { ONCALL_WEBHOOK_URL: env.ONCALL_WEBHOOK_URL, LISTENER_AUDIO_CHECK_DRILL: "true" },
      log: (s) => logs.push(s),
      fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return ok({});
      },
    }),
    0,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, env.ONCALL_WEBHOOK_URL);
  assert.equal(calls[0].body.drill, true);
  assert.deepEqual(
    calls[0].body,
    oncallPayload(
      calls[0].body.incidents.map(({ key, detail }) => ({ key, detail })),
      { drill: true },
    ),
  );
  assert.match(calls[0].body.incidents[0].detail, /Drill:/);
  assert.deepEqual(logs, []);
});

test("missing secrets name requirements and drill requires only webhook", async () => {
  await assert.rejects(run({ env: {} }), /ONCALL_WEBHOOK_URL, CHALK_AXIOM_QUERY_TOKEN, CHALK_AXIOM_LOG_DATASET/);
  await assert.rejects(run({ env: { LISTENER_AUDIO_CHECK_DRILL: "true" } }), /^Error: Missing required secrets: ONCALL_WEBHOOK_URL$/);
});

test("HTTP, JSON, malformed and network failures fail safely", async () => {
  const args = { token: "fake", dataset: "fake", ...window };
  await assert.rejects(readSignals({ ...args, fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  await assert.rejects(readSignals({ ...args, fetchImpl: async () => ok({}) }), /malformed tabular/);
  await assert.rejects(
    readSignals({
      ...args,
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new Error(id);
        },
      }),
    }),
    /^Error: Axiom returned invalid JSON$/,
  );
  await assert.rejects(
    readSignals({
      ...args,
      fetchImpl: async () => {
        throw new Error(id);
      },
    }),
    /^Error: Axiom query request failed$/,
  );
  for (const network of [false, true]) {
    await assert.rejects(
      run({
        env,
        now,
        log: () => {},
        fetchImpl: async (url) => {
          if (url !== env.ONCALL_WEBHOOK_URL) return ok(await fixture("one"));
          if (network) throw new Error(id);
          return { ok: false, status: 500 };
        },
      }),
      network ? /^Error: Oncall webhook request failed$/ : /HTTP 500/,
    );
  }
});
