// Usage: node silence-repro-analyze.mjs <silence-repro.json>... ; prints silent rate per build and condition.
import { readFileSync } from "node:fs";

const DEADLINE = 15;
const LEVEL = 0.01;
const stages = ["not in roster", "in roster, no remote publication", "publication but track missing or ended", "live track, no bytes", "bytes flowing, audioLevel 0", "audible but element unbound/paused/not playing"];

function entryFor(sample, listener, speaker) {
  return sample.states[listener]?.remote.find((entry) => entry.speaker === speaker);
}
function stageAt(sample, listener, speaker) {
  const state = sample.states[listener];
  if (!state || state.error) return 0;
  if (!state.roster.includes(speaker)) return 0;
  const entry = entryFor(sample, listener, speaker);
  if (!entry) return 1;
  if (!entry.trackId || entry.readyState !== "live") return 2;
  if (!entry.inbound || entry.inbound.bytes === 0) return 3;
  if ((entry.inbound.audioLevel ?? 0) <= LEVEL) return 4;
  if (!entry.element?.bound || entry.element.paused || entry.element.play !== "ok") return 5;
  return 6;
}

function enabledAt(run, speaker, from, to) {
  return run.samples.find((sample) => sample.t >= from && sample.t <= to && sample.states[speaker]?.mic === "enabled");
}
const cells = new Map();
const failures = [];
for (const file of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  for (const run of report.runs) {
    const key = `${run.build} | ${run.condition}`;
    const cell = cells.get(key) ?? {
      runs: 0,
      errored: 0,
      pairs: 0,
      silent: 0,
      speakerAll: 0,
      speakerDeaf: 0,
      late: 0,
      p: [],
      stagesSilent: new Map(),
      first: { pairs: 0, silent: 0 },
      again: { pairs: 0, silent: 0 },
      tracksErr: 0,
      pulls: 0,
      neverEnabled: 0,
      elementBad: 0,
      unmutes: 0,
      s410: 0,
      sessions: [],
      kills: 0,
    };
    cells.set(key, cell);
    cell.runs++;
    if (run.error || !run.samples.length) {
      cell.errored++;
      continue;
    }
    cell.kills += run.kills.length;
    cell.sessions.push(...(run.sessionsPerParticipant ?? []));
    for (const entry of run.network) {
      if (entry.method === "POST" && entry.locations === "remote") {
        cell.pulls++;
        if (entry.trackErrors?.length) cell.tracksErr++;
      }
      if (entry.status === 410) cell.s410++;
    }
    const n = run.samples[0].states.length;
    const byParticipant = new Map();
    for (const action of run.actions) {
      const list = byParticipant.get(action.participant) ?? [];
      list.push(action);
      byParticipant.set(action.participant, list);
    }
    for (const [speaker, actions] of byParticipant) {
      actions.forEach((action, i) => {
        if (action.kind !== "unmute" || action.error) return;
        const next = actions[i + 1]?.t ?? Infinity;
        if (Math.min(next, run.samples.at(-1).t) - action.t < DEADLINE) return; // censored
        cell.unmutes++;
        const enabled = enabledAt(run, speaker, action.t, action.t + DEADLINE);
        if (!enabled) {
          cell.neverEnabled++; // the publisher never reached enabled: not a listener-side failure
          return;
        }
        const end = Math.min(next, enabled.t + DEADLINE);
        const window = run.samples.filter((sample) => sample.t >= enabled.t && sample.t <= end);
        let anyListener = false;
        for (let listener = 0; listener < n; listener++) {
          if (listener === speaker) continue;
          let heard = null;
          let last = null;
          let best = 0;
          let prevBytes = null;
          for (const sample of window) {
            const entry = entryFor(sample, listener, speaker);
            const bytes = entry?.inbound?.bytes ?? 0;
            if (entry && prevBytes !== null && bytes > prevBytes && (entry.inbound?.audioLevel ?? 0) > LEVEL) {
              heard = sample.t - enabled.t;
              if (!entry.element?.bound || entry.element.paused || entry.element.play !== "ok") cell.elementBad++;
              break;
            }
            prevBytes = entry?.trackId ? bytes : null;
            best = Math.max(best, stageAt(sample, listener, speaker));
            last = sample;
          }
          const bucket = action.first ? cell.first : cell.again;
          cell.pairs++;
          bucket.pairs++;
          if (heard === null) {
            cell.silent++;
            bucket.silent++;
            const finalStage = Math.min(best, 5);
            cell.stagesSilent.set(stages[finalStage] ?? `stage ${finalStage}`, (cell.stagesSilent.get(stages[finalStage] ?? `stage ${finalStage}`) ?? 0) + 1);
            failures.push({ key, runIndex: run.runIndex, speaker, listener, t: action.t, first: action.first, bestStage: stages[finalStage] });
          } else {
            cell.p.push(heard);
            anyListener = true;
            if (heard > 5) cell.late++;
          }
        }
        cell.speakerAll++;
        if (!anyListener) cell.speakerDeaf++;
      });
    }
  }
}
const pct = (list, p) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))].toFixed(1) : "-");
for (const [key, cell] of [...cells].sort()) {
  console.log(
    `\n${key}: runs ${cell.runs} (errored ${cell.errored}), listener-speaker pairs ${cell.pairs}, silent ${cell.silent} (${cell.pairs ? ((100 * cell.silent) / cell.pairs).toFixed(1) : "-"}%), first-unmute silent ${cell.first.silent}/${cell.first.pairs}, re-unmute silent ${cell.again.silent}/${cell.again.pairs}`,
  );
  console.log(`  unmutes analysed ${cell.unmutes}, publisher never reached enabled ${cell.neverEnabled}, heard but element not bound/playing ${cell.elementBad}`);
  console.log(`  speakers heard by nobody: ${cell.speakerDeaf}/${cell.speakerAll}; heard later than 5 s: ${cell.late}; time-to-heard p50 ${pct(cell.p, 0.5)} p90 ${pct(cell.p, 0.9)} max ${pct(cell.p, 0.999)}`);
  console.log(`  remote pulls ${cell.pulls}, with trackErrors ${cell.tracksErr}, HTTP 410 ${cell.s410}, kills ${cell.kills}, sessions per participant mean ${(cell.sessions.reduce((a, b) => a + b, 0) / Math.max(1, cell.sessions.length)).toFixed(1)}`);
  for (const [stage, count] of cell.stagesSilent) console.log(`  silent pairs by furthest stage: ${stage}: ${count}`);
}
console.log(`\nFirst silent examples:`);
for (const failure of failures.slice(0, 8)) console.log(JSON.stringify(failure));
