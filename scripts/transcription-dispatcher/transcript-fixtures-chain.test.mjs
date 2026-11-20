// @ts-check
/**
 * Hop (b) of every transcript symptom's coverage chain: assembles the positive and healthy fixtures from the row hand-off
 * files the fault scenarios wrote under observability/fixtures/transcript.<code>/chain/, judges each with the symptom's own
 * rule, and proves the fixture contract —
 *
 *   - the positive fixture yields at least one finding for its symptom;
 *   - the healthy fixture yields none, and its item is checked (`checked === eligible > 0`), so it proves a real pass.
 *
 * With CHALK_CHAIN_WRITE=1 it writes ../positive.json and ../healthy.json (the hop's `writes`); a plain run compares them
 * with the committed fixtures, so a hand-edited fixture fails here.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkFrom } from "../diagnose-call/proof/catalogue.mjs";
import { judgeFixture, ruleResult } from "../diagnose-call/proof/rows.mjs";
import coverage from "./chain-inputs/transcript.coverage.mjs";
import { worldInput, writeOrCompareFixture } from "./fixture-rows.helper.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHAIN_DIR = (code) => `observability/fixtures/${code}/chain`;

/** What each fixture proves, in one line. */
const DESCRIPTIONS = {
  "transcript.attempt_lost": {
    positive: "A transcription_chunk job still leased with an expired lease and no accepted attempt, result or retry decision: the attempt was lost.",
    healthy: "A transcription_chunk job that claimed, transcribed and completed on its first attempt.",
  },
  "transcript.failed": {
    positive: "A transcription_chunk job dead-lettered on the provider's rejection while its transcription ended terminal_failure.",
    healthy: "A transcription_chunk job that claimed, transcribed and completed on its first attempt.",
  },
  "transcript.late": {
    positive: "A transcription_finalize job whose transcription completed more than sixty minutes after it was created.",
    healthy: "A transcription_finalize job that claimed, finalized and completed with a readable transcript.",
  },
  "transcript.speech_dropped": {
    positive: "A transcription_finalize job whose accepted provider attempt measured seconds of speech while the stored transcript holds zero cues.",
    healthy: "A transcription_finalize job that claimed, finalized and completed with a readable transcript.",
  },
  "transcript.stuck": {
    positive: "A transcription_chunk job still pending five minutes after it went available, with no claim decision.",
    healthy: "A transcription_chunk job that claimed, transcribed and completed on its first attempt.",
  },
  "transcript.talk_time_stuck": {
    positive: "An Episode still reporting transcript_pending ten minutes after its Recording's transcription prep died terminally.",
    healthy: "An Episode whose transcript completed and whose talk time reports available.",
  },
  "transcript.unreadable": {
    positive: "A transcription_finalize job that completed with an artifact its R2 readback cannot find.",
    healthy: "A transcription_finalize job that claimed, finalized and completed with a readable transcript.",
  },
  "transcript.wake_lost": {
    positive: "A transcription_chunk job whose wake failed and whose first claim came more than ninety seconds after creation.",
    healthy: "A transcription_chunk job that claimed, transcribed and completed on its first attempt.",
  },
};

/** Chain-file order inside a fixture: the item's own rows by source, then the witness and coverage hand-offs. */
const RANK = ["db", "api", "lambda", "r2", "witness", "coverage"];
const rank = (name) => RANK.findIndex((prefix) => name.startsWith(`${prefix}-rows.`));

const registry = JSON.parse(readFileSync(join(ROOT, "observability/generated/registry.json"), "utf8"));
const declared = new Map(registry.symptoms.map((symptom) => [symptom.code, symptom]));

for (const code of Object.keys(coverage.items)) {
  const spec = coverage.items[code];
  const runs = [
    { run: "positive", item: spec.positive, input: `transcript.${code.slice("transcript.".length)}.positive.mjs` },
    { run: "healthy", item: spec.healthy, input: `transcript.${code.slice("transcript.".length)}.healthy.mjs` },
  ];
  for (const { run, item, input } of runs) {
    test(`${code} ${run}: the chain rows judge the ${run} fixture`, async () => {
      const dir = join(ROOT, CHAIN_DIR(code));
      const files = readdirSync(dir)
        .filter((name) => name.endsWith(`-rows.${run}.json`) && rank(name) >= 0)
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      assert(files.length > 0, `${code}: no ${run} hand-off rows under ${CHAIN_DIR(code)}/: run the fault scenario first`);
      const chain = files.map((name) => `${CHAIN_DIR(code)}/${name}`);
      const rows = files.flatMap((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));

      const world = await worldInput(input);
      const declaration = world.declarations.find((d) => d.id === item);
      assert(declaration, `${input} declares no item ${item}`);
      // The fixture's as-of is when the rows are judged: at least the capture's, and at least the item's own end, so the
      // synthesized complete watermarks cover the check's whole window.
      const asof_ms = Math.max(world.asof_ms, declaration.window.to_ms ?? 0);
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
