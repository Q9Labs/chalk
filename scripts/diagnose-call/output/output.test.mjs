// @ts-check
/**
 * Output contract tests over the 18 Nov world. Goldens live in ../golden as `<name>.txt` and `<name>.json`; rewrite them with
 * `DIAGNOSE_GOLDEN=write node --test scripts/diagnose-call/output/output.test.mjs`, then recount tokens with
 * `uv run -q --no-project --with tiktoken python scripts/diagnose-call/golden/count_tokens.py`.
 * The rules hash is normalized when comparing, so a kernel edit does not churn every golden.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { run } from "../diagnose.mjs";
import { renderText } from "./text.mjs";

const GOLDEN = new URL("../golden/", import.meta.url);
const WRITE = process.env.DIAGNOSE_GOLDEN === "write";

/** @type {Record<string, string[]>} */
export const GOLDENS = {
  "episode-9feb": ["ep_9feb"],
  "evidence-no-voice": ["evidence", "f_5b55"],
  "day-th": ["day", "TH", "2026-11-18"],
  "check-th": ["check", "TH", "2026-11-18"],
  "participant-haris": ["participant", "usr_th-1041"],
  "pattern-no-voice": ["pattern", "audio.not_heard", "--tenant", "TH"],
  "resolve-haris": ["Haris"],
  "attempt-unresolved": ["attempt", "cs_6d5e"],
  "space-day": ["space", "spc_5bac", "2026-11-18"],
  "tenant-day": ["tenant", "ten_1f0c", "2026-11-18"],
  "platform-day": ["platform", "production", "2026-11-18"],
  "job-recording": ["job", "job_4a3b"],
};

const normalize = (/** @type {string} */ text) => text.replace(/rules=[0-9a-f]{8}/gu, "rules=R").replace(/"rules":"[0-9a-f]{8}"/gu, '"rules":"R"');

/** @param {string[]} argv */
async function diagnose(argv) {
  const result = await run([...argv, "--fixture", "nov18"]);
  assert.equal(result.err, "", `diagnose ${argv.join(" ")} wrote to stderr`);
  return result;
}

const HANDLE = /\b(?:ten|ep|pt|usr|agt|cs|mc|jr|job|f|ev)_[0-9a-z]{4,}\b/gu;
const handles = (/** @type {string} */ text) => [...new Set(text.match(HANDLE) ?? [])].sort();

describe("goldens", () => {
  for (const [name, argv] of Object.entries(GOLDENS)) {
    it(`${name} in text and JSON`, async () => {
      const text = (await diagnose(argv)).out;
      const json = (await diagnose([...argv, "--json"])).out;
      if (WRITE) {
        writeFileSync(new URL(`${name}.txt`, GOLDEN), text);
        writeFileSync(new URL(`${name}.json`, GOLDEN), json);
      }
      assert.equal(normalize(text), normalize(readFileSync(new URL(`${name}.txt`, GOLDEN), "utf8")));
      assert.equal(normalize(json), normalize(readFileSync(new URL(`${name}.json`, GOLDEN), "utf8")));
      assert.deepEqual(handles(json), handles(text), "text and JSON carry the same handles");
      const view = JSON.parse(json);
      assert.equal(view.v, 1);
      const first = text.split("\n")[0];
      if (view.head.outcome) assert.ok(first.includes(`outcome=${view.head.outcome}`));
      if (view.head.coverage) assert.ok(first.includes(`coverage=${view.head.coverage.state}`));
      assert.equal(text.split("\n").filter((line) => line.startsWith("gap: ")).length, view.gaps.length, "every gap is a line");
    });
  }

  it("renders the reviewer's corrected 18 Nov example: partial coverage that names the board, no cause from zero voiced packets", async () => {
    const text = (await diagnose(["ep_9feb"])).out;
    const [first, anchor, finding, fact] = text.split("\n");
    assert.match(first, /^episode ep_9feb tenant=TH outcome=broken coverage=partial\(board\) checked=9\/13 asof=2026-11-19T01:00Z rules=[0-9a-f]{8}$/u);
    assert.equal(anchor, "anchor=2026-11-18T09:45Z local=14:45+05:00 dur=60m seats=4");
    assert.match(finding, /^f_5b55 broken audio\.not_heard pt_4c1e\(Haris\) \+07:10\.\.\+10:40 hop=sfu_ingress module=unknown upstream=unknown ev=ev_a1f3$/u);
    assert.equal(fact, "fact: SFU ingress 10480 packets, 0 voiced [ev_a1f3]");
    assert.ok(!text.includes("hypothesis:"), "no hypothesis without an upstream witness");
    assert.ok(text.includes("gap: board.view_jumped all 4 seats: board.camera not emitted by client 3.1.0"));
    assert.ok(text.includes("next: diagnose evidence f_5b55"));
  });

  it("matches the token counts recorded for the goldens", () => {
    /** @type {Record<string, { sha256: string, o200k: number }>} */
    const counts = JSON.parse(readFileSync(new URL("tokens.json", GOLDEN), "utf8"));
    for (const name of Object.keys(GOLDENS)) {
      for (const form of ["txt", "json"]) {
        const file = `${name}.${form}`;
        const sha = createHash("sha256")
          .update(readFileSync(new URL(file, GOLDEN)))
          .digest("hex");
        assert.equal(counts[file]?.sha256, sha, `${file} changed: recount with uv run -q --no-project --with tiktoken python scripts/diagnose-call/golden/count_tokens.py`);
      }
      assert.ok(counts[`${name}.txt`].o200k < counts[`${name}.json`].o200k, `${name}: text is the compact default, so it must cost less than JSON`);
    }
    assert.ok(counts["episode-9feb.txt"].o200k <= CEILING.episode, `the 18 Nov Episode costs ${counts["episode-9feb.txt"].o200k} tokens, over ${CEILING.episode}`);
    assert.ok(counts["day-th.txt"].o200k <= CEILING.day, `the day view costs ${counts["day-th.txt"].o200k} tokens, over ${CEILING.day}`);
  });
});

/** o200k ceilings. The plan's compact sample was 187 tokens without its facts, report and proof handles. */
const CEILING = { episode: 270, day: 240 };

describe("paging", () => {
  it("pages records with a stable cursor and never pages status or gaps", async () => {
    const seen = [];
    let argv = ["ep_9feb", "--limit", "1"];
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const out = (await diagnose(argv)).out;
      const lines = out.split("\n");
      assert.ok(lines[0].startsWith("episode ep_9feb"), "status is on every page");
      assert.ok(
        lines.some((line) => line.startsWith("gap: board.view_jumped")),
        "gaps are on every page",
      );
      seen.push(...lines.filter((line) => /^(f_|report )/u.test(line)));
      const cursor = /--cursor (c_\S+)/u.exec(out)?.[1];
      if (!cursor) break;
      assert.match(out, /^more: \d+ omitted by limit \(limit=1\)$/mu);
      argv = ["ep_9feb", "--limit", "1", "--cursor", cursor];
    }
    const all = (await diagnose(["ep_9feb"])).out.split("\n").filter((line) => /^(f_|report )/u.test(line));
    assert.deepEqual(seen, all, "following cursors shows every record once, in order");
  });

  it("rejects a cursor from another view", async () => {
    const out = (await diagnose(["ep_9feb", "--limit", "1"])).out;
    const cursor = /--cursor (c_\S+)/u.exec(out)?.[1] ?? "";
    const result = await run(["day", "TH", "2026-11-18", "--cursor", cursor, "--fixture", "nov18"]);
    assert.equal(result.code, 64);
    assert.match(result.err, /belongs to another view/u);
  });

  it("stops at a budget, says so, and still prints every gap", async () => {
    const out = (await diagnose(["day", "TH", "2026-11-18", "--budget", "10"])).out;
    assert.match(out, /^more: \d+ omitted by budget/mu);
    assert.equal(out.split("\n").filter((line) => line.startsWith("gap: ")).length, 4);
  });
});

describe("lookup", () => {
  it("returns candidates for an ambiguous name, never a silent pick", async () => {
    const { out, code } = await diagnose(["Haris"]);
    assert.equal(code, 0);
    assert.match(out.split("\n")[0], /^resolve "Haris" matched=2 /u);
    assert.equal(out.split("\n").filter((line) => line.startsWith("cand ")).length, 2);
    assert.equal((await diagnose(["Haris", "--strict"])).code, 2);
  });

  it("opens the only match inside a tenant and says how it resolved", async () => {
    const out = (await diagnose(["Haris", "--tenant", "TH"])).out;
    assert.match(out, /^participant usr_th-1041\(Haris\) /u);
    assert.match(out, /^via: "Haris" as user Haris$/mu);
  });

  it("resolves a session id in each of its meanings and says which matched", async () => {
    const client = (await diagnose(["3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7"])).out;
    assert.match(client, /^via: .* as client_session /mu);
    const media = (await diagnose(["8f2c1a0b9e8d7c6b5a4f3e2d1c0b9a8f"])).out;
    assert.match(media, /^via: .* as media_connection\(provider_media\) /mu);
    const episode = (await diagnose(["9feb0ff6-3c1a-4e7b-9a52-0d4c8e1f2a77"])).out;
    assert.match(episode, /^via: .* as episode /mu);
  });

  it("opens a guest's seat by name", async () => {
    const out = (await diagnose(["Bilal"])).out;
    assert.match(out, /^participant pt_e5f7\(Bilal\) tenant=TH range=\S+ outcome=unknown /u, "a guest with no finding in a broken Episode is not called broken");
  });

  it("looks up a window and a Participant across a date range", async () => {
    const window = (await diagnose(["window", "TH", "--from", "2026-11-18T09:00Z", "--to", "2026-11-18T11:00Z"])).out;
    assert.match(window, /^window tenant=TH /u);
    assert.ok(window.includes("f_5b55"));
    const range = (await diagnose(["participant", "usr_th-1041", "--from", "2026-11-01", "--to", "2026-11-12"])).out;
    assert.ok(range.includes("ep_2d4e") && !range.includes("ep_9feb"));
  });
});

describe("contract", () => {
  it("refuses to say coverage is complete while listing a gap", () => {
    /** @type {import("./views.mjs").View} */
    const view = {
      v: 1,
      view: "episode",
      head: { view: "episode", scope: { item: "ep_x", tenant: "T" }, outcome: "healthy", coverage: { state: "complete", missing: [] }, checked: 1, eligible: 1, asof: "a", rules: "r", stale: null },
      anchor: null,
      via: null,
      records: [],
      gaps: [{ t: "gap", code: "x", why: "y" }],
      page: null,
      next: [],
    };
    assert.throws(() => renderText(view), /coverage complete with 1 gap lines/u);
  });

  it("exits 64 on a usage mistake and 69 without a fixture", async () => {
    assert.equal((await run(["ep_9feb", "--bogus"])).code, 64);
    assert.equal((await run(["ep_9feb"])).code, 69);
  });

  it("exits 3 under --strict when something is broken, 2 when coverage is partial", async () => {
    assert.equal((await diagnose(["ep_9feb", "--strict"])).code, 3);
    assert.equal((await diagnose(["ep_31aa", "--strict"])).code, 2);
  });
});

describe("review fixes", () => {
  /** @param {string} out */
  const nextOf = (out) =>
    out
      .split("\n")
      .filter((line) => line.startsWith("next: diagnose "))
      .map((line) => line.slice("next: diagnose ".length));
  /** Splits a printed command the way a shell would, for the quoting quoteArg produces. @param {string} command */
  const argvOf = (command) => [...command.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/gu)].map((match) => (match[1] === undefined ? match[2] : JSON.parse(`"${match[1]}"`)));

  it("prints only next: commands that run", async () => {
    const starts = [...Object.values(GOLDENS), ["check", "TH", "--limit", "2"], ["pt_4c1e", "--limit", "1"], ["participant", "usr_th-1041", "--limit", "1"], ["day", "TH", "2026-11-18", "--limit", "1"], ["participant", "Haris", "--from", "2026-11-01", "--to", "2026-11-12"]];
    for (const argv of starts) {
      for (const command of nextOf((await diagnose(argv)).out)) {
        const result = await run([...argvOf(command), "--fixture", "nov18"]);
        assert.equal(result.code, 0, `diagnose ${command} (from ${argv.join(" ")}) exited ${result.code}: ${result.err.split("\n")[0]}`);
      }
    }
  });

  it("pages check results with a cursor, so the omitted items are reachable", async () => {
    const out = (await diagnose(["check", "TH", "--limit", "2"])).out;
    assert.match(out, /^next: diagnose check TH --cursor c_\S+$/mu);
  });

  it("gives the same cursor scope whether a person was reached by seat or by user", async () => {
    const bySeat = (await diagnose(["pt_4c1e", "--limit", "1"])).out;
    const byUser = (await diagnose(["participant", "usr_th-1041", "--limit", "1"])).out;
    assert.equal(bySeat.split("\n")[0], byUser.split("\n")[0]);
    assert.equal(/--cursor (c_\S+)/u.exec(bySeat)?.[1], /--cursor (c_\S+)/u.exec(byUser)?.[1]);
  });

  it("keeps the asked range in an ambiguous person's candidates", async () => {
    const out = (await diagnose(["participant", "Haris", "--from", "2026-11-01", "--to", "2026-11-12"])).out;
    for (const command of nextOf(out)) assert.match(command, /--from 2026-11-01 --to 2026-11-12$/u);
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
