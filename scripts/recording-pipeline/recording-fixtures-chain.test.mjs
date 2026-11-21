// @ts-check
/**
 * Hop (b) of every slice-10 recording symptom's coverage chain: assembles the positive and healthy
 * fixtures from the row hand-off files the fault scenarios wrote under
 * observability/fixtures/<code>/chain/, judges each with the symptom's own rule, and proves the
 * fixture contract —
 *
 *   - the positive fixture yields at least one finding for its symptom;
 *   - the healthy fixture yields none, and its item is checked (`checked === eligible > 0`), so it
 *     proves a real pass.
 *
 * With CHALK_CHAIN_WRITE=1 it writes ../positive.json and ../healthy.json (the hop's `writes`); a
 * plain run compares them with the committed fixtures, so a hand-edited fixture fails here.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkFrom } from "../diagnose-call/proof/catalogue.mjs";
import { judgeFixture, ruleResult } from "../diagnose-call/proof/rows.mjs";
import coverage from "./chain-inputs/recording.coverage.mjs";
import { writeOrCompareFixture } from "./fixture-rows.helper.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHAIN_DIR = (code) => `observability/fixtures/${code}/chain`;

/** What each fixture proves, in one line. */
const DESCRIPTIONS = {
  "recording.capture_failed": {
    positive: "A capture job dead in terminal_failure on a media_io attempt failure, its attempt journal named.",
    healthy: "A capture job that claimed inside the bound and committed its media bundles.",
  },
  "recording.empty": {
    positive: "A capture job reporting capture_empty while the SFU witnessed a participant publishing media.",
    healthy: "A capture job that claimed inside the bound and committed its media bundles.",
  },
  "recording.missing_span": {
    positive: "A capture job whose claim lag ran past the fleet bound while a later attempt still claimed.",
    healthy: "A capture job that claimed inside the bound and committed its media bundles.",
  },
  "recording.never_captured": {
    positive: "A capture job still pending when the Episode ended: the stopped_before_claim shape.",
    healthy: "A capture job that claimed inside the bound and committed its media bundles.",
  },
  "recording.stuck": {
    positive: "A capture job leased with an unmoving pipeline long past the Episode-end bound.",
    healthy: "A capture job that claimed inside the bound and committed its media bundles.",
  },
  "render.failed": {
    positive: "A render job dead in terminal_failure on the probe error, its attempt journal named.",
    healthy: "A render job that composed, probed and committed a readable MP4.",
  },
  "recording.artifact_unreadable": {
    positive: "A committed render whose stored bytes fail the committed checksum on the real readback.",
    healthy: "A render job that composed, probed and committed a readable MP4.",
  },
  "playback.url_expired": {
    positive: "A dashboard playback failing on a URL older than its signed lifetime, mint row to prove it.",
    healthy: "A minted playback URL used inside its lifetime with the player progressing.",
  },
  "playback.decode_failed": {
    positive: "A dashboard playback failing decode inside the URL's lifetime on an object the readback proves readable.",
    healthy: "A minted playback URL used inside its lifetime with the player progressing.",
  },
  "recording.not_ready": {
    positive: "A render job dead in terminal_failure while the Recording stays unreadable for download.",
    healthy: "A render job that composed, probed and committed a readable MP4.",
  },
};

const registry = JSON.parse(readFileSync(join(ROOT, "observability/generated/registry.json"), "utf8"));
const declared = new Map(registry.symptoms.map((symptom) => [symptom.code, symptom]));

/** Chain-file order inside a fixture: the item's own rows by source, then the witness and coverage hand-offs. */
const RANK = ["db", "api", "sfu", "recorder", "client", "web", "r2", "lambda"];
const rank = (name) => {
  const i = RANK.findIndex((prefix) => name.startsWith(`${prefix}-rows.`));
  return i === -1 ? (name.startsWith("witness-rows.") ? RANK.length : name.startsWith("coverage-rows.") ? RANK.length + 1 : -1) : i;
};

for (const code of Object.keys(coverage.items)) {
  const spec = coverage.items[code];
  for (const run of ["positive", "healthy"]) {
    test(`${code} ${run}: the chain rows judge the ${run} fixture`, async () => {
      const dir = join(ROOT, CHAIN_DIR(code));
      const files = existsSync(dir)
        ? readdirSync(dir)
            .filter((name) => name.endsWith(`-rows.${run}.json`) && rank(name) >= 0)
            .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
        : [];
      assert(files.length > 0, `${code}: no ${run} hand-off rows under ${CHAIN_DIR(code)}/: run the fault scenario first`);
      const chain = files.map((name) => `${CHAIN_DIR(code)}/${name}`);
      const rows = files.flatMap((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));

      const { declaration, asof_ms } = spec[run];
      const fixture = { description: DESCRIPTIONS[code][run], asof_ms, declaration, chain, rows };

      const symptom = declared.get(code);
      assert(symptom, `${code} is not in the generated registry: run pnpm run regen`);
      const check = checkFrom(symptom, await import(pathToFileURL(join(ROOT, symptom.rule)).href));
      const { verdict } = judgeFixture(fixture, [check], code);
      const { findings, checked, eligible } = ruleResult(verdict, code);
      if (run === "positive") assert(findings >= 1, `${code}: the positive fixture yields no ${code} finding`);
      else {
        assert.equal(findings, 0, `${code}: the healthy fixture yields ${findings} ${code} finding(s)`);
        assert(eligible > 0 && checked === eligible, `${code}: the healthy fixture checks ${checked} of ${eligible} subject(s), so it proves nothing healthy`);
      }

      writeOrCompareFixture(join(ROOT, "observability", "fixtures", code, `${run}.json`), fixture);
    });
  }
}
