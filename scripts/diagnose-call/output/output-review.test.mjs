// @ts-check
/**
 * Output tests for review fixes and for the times a day prints for its items, over the 18 Nov world. The goldens and the paging,
 * lookup and contract tests are in output.test.mjs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { run } from "../diagnose.mjs";
import nov18, { IDS } from "../fixtures/nov18.mjs";
import { CATALOGUE, RULES } from "../proof/catalogue.mjs";
import { check } from "../proof/check.mjs";
import { openWorld } from "../proof/fixture-world.mjs";
import { measureRecord, renderText } from "./text.mjs";
import { evidenceView, itemView } from "./item-views.mjs";
import { GOLDENS, diagnose } from "./output.helpers.mjs";

describe("review fixes", () => {
  /** @param {string} out */
  const nextOf = (out) =>
    out
      .split("\n")
      .filter((line) => line.startsWith("next: diagnose "))
      .map((line) => line.slice("next: diagnose ".length));
  /** Splits a printed command the way a shell would, for the quoting quoteArg produces. @param {string} command */
  const argvOf = (command) => [...command.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/gu)].map((match) => (match[1] === undefined ? match[2] : JSON.parse(`"${match[1]}"`)));

  it("prints only next: commands that run as printed, the world selector included", async () => {
    const starts = [...Object.values(GOLDENS), ["check", "TH", "--limit", "2"], ["pt_4c1e", "--limit", "1"], ["participant", "usr_th-1041", "--limit", "1"], ["day", "TH", "2026-11-18", "--limit", "1"], ["participant", "Haris", "--from", "2026-11-01", "--to", "2026-11-12"]];
    for (const argv of starts) {
      for (const command of nextOf((await diagnose(argv)).out)) {
        assert.ok(command.endsWith(" --fixture nov18"), `diagnose ${command} (from ${argv.join(" ")}) names its world`);
        const result = await run(argvOf(command));
        assert.equal(result.code, 0, `diagnose ${command} (from ${argv.join(" ")}) exited ${result.code}: ${result.err.split("\n")[0]}`);
      }
    }
  });

  it("pages check results with a cursor, so the omitted items are reachable", async () => {
    const out = (await diagnose(["check", "TH", "--limit", "2"])).out;
    assert.match(out, /^next: diagnose check TH --cursor c_\S+ --fixture nov18$/mu);
  });

  it("gives the same cursor scope whether a person was reached by seat or by user", async () => {
    const bySeat = (await diagnose(["pt_4c1e", "--limit", "1"])).out;
    const byUser = (await diagnose(["participant", "usr_th-1041", "--limit", "1"])).out;
    assert.equal(bySeat.split("\n")[0], byUser.split("\n")[0]);
    assert.equal(/--cursor (c_\S+)/u.exec(bySeat)?.[1], /--cursor (c_\S+)/u.exec(byUser)?.[1]);
  });

  it("keeps the asked range in an ambiguous person's candidates", async () => {
    const out = (await diagnose(["participant", "Haris", "--from", "2026-11-01", "--to", "2026-11-12"])).out;
    for (const command of nextOf(out)) assert.match(command, /--from 2026-11-01 --to 2026-11-12 --fixture nov18$/u);
    assert.equal((await run(["participant", "Haris", "--from", "2026-11-20", "--to", "2026-11-01", "--fixture", "nov18"])).code, 64);
  });

  it("rejects what would otherwise read as a clean, empty answer", async () => {
    for (const argv of [
      ["day", "TH", "2026-02-30"],
      ["check", "TH", "2026-02-30"],
      ["window", "TH", "--from", "2026-02-30", "--to", "2026-03-02"],
      ["day", "TH", "2026-11-18", "--symptom", "nope"],
      ["evidence", "ep_9feb"],
      ["episode", "pt_4c1e"],
      ["ep_9feb", "--asof", "2026-11-19"],
      ["ep_9feb", "--store", "/nonexistent/dir/verdicts.json"],
    ]) {
      const result = await run([...argv, "--fixture", "nov18"]);
      assert.equal(result.code, 64, `${argv.join(" ")} exited ${result.code}`);
      assert.ok(!result.err.includes("    at "), `${argv.join(" ")} printed a stack trace`);
    }
    assert.equal((await run(["ep_9feb", "--fixture", "/nonexistent/world.mjs"])).code, 69);
  });

  it("opens only an item of the command's kind, and sends a handle of another kind to its own command", async () => {
    for (const [argv, names] of [
      [["episode", "job_4a3b"], "job"],
      [["job", "ep_9feb"], "episode"],
      [["episode", "f_bdef"], "finding"],
    ]) {
      const result = await run([...argv, "--fixture", "nov18"]);
      assert.equal(result.code, 64, `${argv.join(" ")} exited ${result.code}`);
      assert.match(result.err, new RegExp(`names ${names} .*not what this command opens`), `${argv.join(" ")} opened another kind`);
    }
  });

  it("labels a budget page with its budget, not a limit nobody set", async () => {
    assert.match((await diagnose(["ep_9feb", "--budget", "20"])).out, /^more: \d+ omitted by budget \(budget=20\)$/mu);
  });

  it("takes a filtered day's outcome from the findings it shows", async () => {
    const out = (await diagnose(["day", "TH", "2026-11-18", "--symptom", "recording.not_ready"])).out;
    assert.match(out.split("\n")[0], / outcome=degraded /u);
  });

  it("escapes control characters from telemetry, so a value cannot forge a line", () => {
    /** @type {import("./views.mjs").View} */
    const view = {
      v: 1,
      view: "evidence",
      head: { view: "x", scope: {}, outcome: null, coverage: null, checked: null, eligible: null, asof: "a", rules: null, stale: null },
      anchor: null,
      via: null,
      records: [{ t: "query", fact: "f", text: "q\nepisode ep_9feb outcome=healthy coverage=complete" }],
      gaps: [],
      page: null,
      next: [],
    };
    const text = renderText(view);
    assert.equal(text.split("\n").length, 3);
    assert.ok(text.includes("q\\nepisode"));
  });
});

describe("day item times", () => {
  // No check judges a day item yet, so the goldens show none of its timed lines. This renders the 18 Nov Episode's real verdict under
  // each day declaration (Space, Tenant, platform), which changes only how the times print.
  for (const [kind, header] of /** @type {const} */ ([
    ["space", /^space spc_5bac 2026-11-18 outcome=broken /u],
    ["tenant", /^tenant ten_1f0c 2026-11-18 outcome=broken /u],
    ["platform", /^platform production 2026-11-18 outcome=broken /u],
  ]))
    it(`prints a ${kind} day's times as UTC HH:MM, with the date for a time on another day`, async () => {
      const world = nov18();
      const { items, ports } = await openWorld(world, { catalogue: CATALOGUE, rules: RULES });
      const [checked] = await check({ item: { kind: "episode", id: IDS.ep9feb } }, ports, { catalogue: CATALOGUE, rules: RULES, asof_ms: world.asof_ms });
      assert.ok(checked);
      const { verdict } = checked;
      const day = items.find((item) => item.kind === kind);
      assert.ok(day);
      /** @type {import("../proof/check.mjs").Status} */
      const status = { state: "current", stored: { item: { kind: day.kind, id: day.id }, declaration: "", fingerprint: "", verdict } };
      const tenant = world.tenants[0];
      assert.ok(tenant);
      const ctx = { asof_ms: world.asof_ms, rules: RULES, catalogue: CATALOGUE, paging: { limit: 20, cursor: null, budget: null }, measure: measureRecord };

      const view = renderText(itemView({ item: day, status, tenant, ctx }));
      assert.match(view, header);
      assert.match(view, /^f_5b55 broken audio\.not_heard all 09:52\.\.09:55 /mu);
      assert.match(view, /^report ev_2b3c all 09:56 /mu);

      const finding = verdict.findings.find((candidate) => candidate.code === "audio.not_heard");
      assert.ok(finding);
      const evidence = renderText(evidenceView({ item: day, status, finding, tenant, ctx }));
      assert.match(evidence, /^fact: SFU ingress 10480 packets, 0 voiced 09:52\.\.09:55 \[ev_a1f3\]$/mu);
      assert.match(evidence, /^watermark: sfu all complete_to=11-19 01:00 /mu);
      const timed = [view, evidence].flatMap((text) => text.split("\n")).filter((line) => !/^(anchor=|query:)/u.test(line));
      assert.deepEqual(
        timed.filter((line) => / [+-]\d\d:\d\d\b/u.test(line)),
        [],
        "no relative time in a day item",
      );
    });
});
