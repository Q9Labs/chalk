// Usage: node heal.mjs <dir-with-room-folders> ; scores the `<profile>+pubdrop` rooms.
// A speaker loses all its UDP for 5 s (startT to endT). For every listener that was audible just before the drop:
//   silent: some second inside the drop was not audible.
//   heal: seconds from the end of the drop to the listener's first audible second (0 = audible at once). A listener still silent
//   when the speaker's next drop starts (or the run ends) counts as never healed, with a floor of that window.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const LEVEL = 0.01;
const BOOT = 4000;
const root = process.argv[2];

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
function interval(drops, statistic) {
  const random = seeded(99);
  const values = [];
  for (let b = 0; b < BOOT; b++) {
    const pairs = [];
    for (let i = 0; i < drops.length; i++) pairs.push(...drops[Math.floor(random() * drops.length)].pairs);
    values.push(statistic(pairs));
  }
  values.sort((a, c) => a - c);
  return [values[Math.floor(BOOT * 0.025)], values[Math.floor(BOOT * 0.975)]];
}
const sec = (x) => (Number.isNaN(x) ? "-" : x.toFixed(1));
const pct = (x) => `${(100 * x).toFixed(1)}%`;

const arms = new Map();
for (const name of readdirSync(root)) {
  const file = join(root, name, "silence-repro.json");
  if (!name.includes("pubdrop") || !existsSync(file)) continue;
  const arm = name.split("-")[2];
  const cell = arms.get(arm) ?? { rooms: 0, errored: 0, drops: [], missingPorts: 0 };
  arms.set(arm, cell);
  for (const run of JSON.parse(readFileSync(file, "utf8")).runs) {
    if (run.error || !run.samples?.length) {
      cell.errored++;
      continue;
    }
    cell.rooms++;
    const lastT = run.samples.at(-1).t;
    const n = run.samples[0].states.length;
    const drops = (run.pubDrops ?? []).filter((drop) => drop.startT !== undefined && drop.endT !== undefined);
    if (drops.length < (run.pubDrops ?? []).length || !drops.length) cell.missingPorts++;
    drops.forEach((drop) => {
      const windowEnd = Math.min(lastT, drop.endT + 12);
      const record = { pairs: [] };
      for (let listener = 0; listener < n; listener++) {
        if (listener === drop.speaker) continue;
        const series = audibleSeries(run, listener, drop.speaker);
        const before = run.samples.some((sample, i) => series[i] && sample.t >= drop.startT - 3 && sample.t < drop.startT);
        if (!before) continue;
        const silent = run.samples.some((sample, i) => !series[i] && sample.t >= drop.startT + 1 && sample.t <= drop.endT);
        const healedAt = run.samples.find((sample, i) => series[i] && sample.t >= drop.endT && sample.t <= windowEnd);
        const heal = healedAt ? Math.max(0, healedAt.t - drop.endT) : null;
        record.pairs.push({ silent, heal, floor: windowEnd - drop.endT });
      }
      if (record.pairs.length) cell.drops.push(record);
    });
  }
}
const out = ["| metric | LiveKit | Chalk 5.4.1 + Cloudflare |", "|---|---|---|"];
const lk = arms.get("lk");
const ck = arms.get("chalk");
const flat = (cell) => cell.drops.flatMap((drop) => drop.pairs);
const healed = (pairs) => pairs.filter((pair) => pair.heal !== null).map((pair) => pair.heal);
const row = (label, fn) => out.push(`| ${label} | ${lk ? fn(lk) : "-"} | ${ck ? fn(ck) : "-"} |`);
row("rooms (errored, rooms with a drop without ports)", (cell) => `${cell.rooms} (${cell.errored}, ${cell.missingPorts})`);
row("drops / pairs that were audible before", (cell) => `${cell.drops.length} / ${flat(cell).length}`);
row("pairs silent during the drop", (cell) => pct(flat(cell).filter((pair) => pair.silent).length / Math.max(1, flat(cell).length)));
row("heal after drop end p50", (cell) => `${sec(quantile(healed(flat(cell)), 0.5))} s`);
row("heal after drop end p95 (healed pairs)", (cell) => `${sec(quantile(healed(flat(cell)), 0.95))} s (${interval(cell.drops, (p) => quantile(healed(p), 0.95)).map(sec).join(" to ")})`);
row("not healed within 12 s of the drop end", (cell) => {
  const pairs = flat(cell);
  const k = pairs.filter((pair) => pair.heal === null).length;
  return `${k} of ${pairs.length} (${pct(k / Math.max(1, pairs.length))}; ${interval(cell.drops, (p) => p.filter((x) => x.heal === null).length / Math.max(1, p.length)).map(pct).join(" to ")})`;
});
row("healed after more than 5 s", (cell) => {
  const pairs = flat(cell);
  const k = pairs.filter((pair) => pair.heal === null || pair.heal > 5).length;
  return `${k} of ${pairs.length} (${pct(k / Math.max(1, pairs.length))})`;
});
console.log(out.join("\n"));
