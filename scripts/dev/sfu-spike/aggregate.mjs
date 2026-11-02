// Usage: node aggregate.mjs <dir-with-room-folders> ; scores every <machine>-<profile>-<arm>-<rep>/silence-repro.json
// with the run-5 definitions (silence-repro-analyze.mjs): a second is audible when inbound bytes rose and audioLevel > 0.01;
// tap-to-heard runs from the tap to the listener's first audible second; a pair is a listener of one tap.
// Intervals are 95% percentile bootstraps that resample whole taps (the pairs of one tap share fate).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const LEVEL = 0.01;
const DEADLINE = 15;
const BOOT = 4000;

const root = process.argv[2];
const rooms = readdirSync(root)
  .filter((name) => existsSync(join(root, name, "silence-repro.json")))
  .map((name) => {
    const [machine, profile, arm, rep] = name.split("-");
    return { name, machine, profile, arm, rep: Number(rep), report: JSON.parse(readFileSync(join(root, name, "silence-repro.json"), "utf8")) };
  });

const entryFor = (sample, listener, speaker) => sample.states[listener]?.remote?.find((entry) => entry.speaker === speaker);
function audibleSeries(run, listener, speaker) {
  let previous = null;
  return run.samples.map((sample) => {
    const entry = entryFor(sample, listener, speaker);
    const bytes = entry?.inbound?.bytes ?? 0;
    const audible = Boolean(entry?.trackId) && (entry.inbound?.audioLevel ?? 0) > LEVEL && (previous?.trackId === entry.trackId ? bytes > previous.bytes : bytes > 0);
    previous = entry?.trackId ? { trackId: entry.trackId, bytes } : null;
    return audible;
  });
}

// One record per tap: the heard time of each listener (null: never within the window), plus the publisher's own enabled time.
function tapsOf(run) {
  const lastT = run.samples.at(-1).t;
  const byParticipant = new Map();
  for (const action of run.actions) byParticipant.set(action.participant, [...(byParticipant.get(action.participant) ?? []), action]);
  const taps = [];
  for (const [speaker, actions] of byParticipant) {
    actions.forEach((action, i) => {
      if (action.kind !== "unmute" || action.error || action.blocked !== undefined) return;
      const end = Math.min(actions[i + 1]?.t ?? Infinity, lastT + 1e-6);
      if (end - action.t < DEADLINE) return;
      const enabled = run.samples.find((sample) => sample.t >= action.t && sample.t <= action.t + DEADLINE && sample.states[speaker]?.mic === "enabled");
      const n = run.samples[0].states.length;
      const heard = [];
      for (let listener = 0; listener < n; listener++) {
        if (listener === speaker) continue;
        if (!enabled) {
          heard.push(null);
          continue;
        }
        const series = audibleSeries(run, listener, speaker);
        const first = run.samples.findIndex((sample, index) => series[index] && sample.t >= action.t && sample.t < end);
        heard.push(first === -1 ? null : run.samples[first].t - action.t);
      }
      taps.push({ first: Boolean(action.first), neverEnabled: !enabled, heard, enabledAfter: enabled ? enabled.t - action.t : null, fromEnabled: heard.filter((v) => v !== null).map((v) => Math.max(0, v - (enabled.t - action.t))) });
    });
  }
  return taps;
}

const quantile = (list, q) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.ceil(list.length * q) - 1)] : NaN);
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
// statistic over the pooled pairs of a resampled set of taps.
function interval(taps, statistic) {
  const random = seeded(4242);
  const values = [];
  for (let b = 0; b < BOOT; b++) {
    const pairs = [];
    for (let i = 0; i < taps.length; i++) pairs.push(...taps[Math.floor(random() * taps.length)].heard);
    values.push(statistic(pairs));
  }
  values.sort((a, c) => a - c);
  return [values[Math.floor(BOOT * 0.025)], values[Math.floor(BOOT * 0.975)]];
}
const rate = (predicate) => (pairs) => pairs.filter(predicate).length / pairs.length;
const never = (value) => value === null;
const tail = (value) => value === null || value > 10;
const slow = (value) => value === null || value > 5;
const audibleOnly = (pairs) => pairs.filter((value) => value !== null);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const ci = ([lo, hi], f = pct) => `${f(lo)} to ${f(hi)}`;
const sec = (x) => (Number.isNaN(x) ? "-" : `${x.toFixed(1)}`);

const cells = new Map();
for (const room of rooms) {
  for (const run of room.report.runs) {
    const key = `${room.profile}|${room.arm}`;
    const cell = cells.get(key) ?? { rooms: 0, errored: 0, stalled: 0, taps: [], shaped: [], machines: new Set() };
    cells.set(key, cell);
    if (run.error || !run.samples?.length) {
      cell.errored++;
      continue;
    }
    cell.rooms++;
    if (run.stalls?.length) cell.stalled++;
    cell.machines.add(room.machine);
    cell.taps.push(...tapsOf(run));
    if (run.shaped) cell.shaped.push(run.shaped);
  }
}

const out = [];
const only = (taps, filter) => taps.filter(filter);
for (const profile of ["open", "home", "mobile"]) {
  out.push(`\n### ${profile}\n`);
  out.push("| metric | LiveKit | Chalk 5.4.1 + Cloudflare |", "|---|---|---|");
  const a = cells.get(`${profile}|lk`);
  const c = cells.get(`${profile}|chalk`);
  if (!a || !c) {
    out.push(`| (missing arm: lk ${Boolean(a)}, chalk ${Boolean(c)}) | | |`);
    continue;
  }
  const row = (label, fn) => out.push(`| ${label} | ${fn(a)} | ${fn(c)} |`);
  const pairsOf = (cell) => cell.taps.flatMap((tap) => tap.heard);
  row("rooms (errored, with a >3 s sampler stall)", (cell) => `${cell.rooms} (${cell.errored}, ${cell.stalled})`);
  row("taps / pairs", (cell) => `${cell.taps.length} / ${pairsOf(cell).length}`);
  row("taps whose publisher never reached enabled", (cell) => `${cell.taps.filter((tap) => tap.neverEnabled).length}`);
  row("tap-to-first-audio p50 (heard pairs)", (cell) => `${sec(quantile(audibleOnly(pairsOf(cell)), 0.5))} s (${ci(interval(cell.taps, (p) => quantile(audibleOnly(p), 0.5)), sec)})`);
  row("tap-to-first-audio p95 (heard pairs)", (cell) => `${sec(quantile(audibleOnly(pairsOf(cell)), 0.95))} s (${ci(interval(cell.taps, (p) => quantile(audibleOnly(p), 0.95)), sec)})`);
  row("tap-to-first-audio p99 (heard pairs)", (cell) => `${sec(quantile(audibleOnly(pairsOf(cell)), 0.99))} s`);
  row("publisher tap-to-enabled p50 / p95; enabled-to-first-audio p50 / p95", (cell) => {
    const en = cell.taps.filter((tap) => tap.enabledAfter !== null).map((tap) => tap.enabledAfter);
    const fe = cell.taps.flatMap((tap) => tap.fromEnabled);
    return `${sec(quantile(en, 0.5))} / ${sec(quantile(en, 0.95))} s; ${sec(quantile(fe, 0.5))} / ${sec(quantile(fe, 0.95))} s`;
  });
  row("never heard (15 s window)", (cell) => `${pairsOf(cell).filter(never).length} (${pct(rate(never)(pairsOf(cell)))}; ${ci(interval(cell.taps, rate(never)))})`);
  row("tail (never heard or over 10 s)", (cell) => `${pairsOf(cell).filter(tail).length} (${pct(rate(tail)(pairsOf(cell)))}; ${ci(interval(cell.taps, rate(tail)))})`);
  row("slow (never heard or over 5 s)", (cell) => `${pairsOf(cell).filter(slow).length} (${pct(rate(slow)(pairsOf(cell)))}; ${ci(interval(cell.taps, rate(slow)))})`);
  row("heard within 3 s", (cell) => pct(rate((v) => v !== null && v <= 3)(pairsOf(cell))));
  for (const [label, filter] of [["first unmute of a speaker", (tap) => tap.first], ["re-unmute after a 4 s mute", (tap) => !tap.first]]) {
    row(`${label}: pairs, p50, p95, slow >5 s`, (cell) => {
      const taps = only(cell.taps, filter);
      const pairs = taps.flatMap((tap) => tap.heard);
      return `${pairs.length}, ${sec(quantile(audibleOnly(pairs), 0.5))} s, ${sec(quantile(audibleOnly(pairs), 0.95))} s, ${pct(rate(slow)(pairs))}`;
    });
  }
  row("shaper: UDP packets seen / dropped", (cell) => {
    const total = cell.shaped.reduce((sum, s) => [sum[0] + s.packets, sum[1] + s.dropped], [0, 0]);
    return `${total[0]} / ${total[1]} (${pct(total[1] / Math.max(1, total[0]))})`;
  });
  row("machines", (cell) => [...cell.machines].sort().join(" "));
}
console.log(out.join("\n"));
