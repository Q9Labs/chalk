// node audio-ready-report.mjs <audio-ready.json>...   Summarises audio-ready-rig output per network profile.
import { readFileSync } from "node:fs";

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const cells = new Map();
for (const file of process.argv.slice(2)) {
  for (const run of JSON.parse(readFileSync(file, "utf8")).runs) {
    const cell = cells.get(run.profile) ?? { rooms: 0, failedRooms: 0, empty: [], cohort: [] };
    cells.set(run.profile, cell);
    cell.rooms++;
    if (!run.listeners) {
      cell.failedRooms++;
      continue;
    }
    for (const listener of run.listeners) {
      const { probe } = listener;
      const readyAt = probe.readiness.find((entry) => entry.state === "ready")?.at ?? null;
      const states = probe.readiness.map((entry) => entry.state);
      const row = {
        readyAt,
        degraded: states.includes("degraded"),
        regressed: readyAt !== null && states.at(-1) !== "ready",
        toReady: readyAt === null ? null : readyAt - probe.joinCalledAt,
        toLive: probe.liveAt === null ? null : probe.liveAt - probe.joinCalledAt,
      };
      if (listener.kind === "cohort") {
        const audible = run.cohort.map((id) => probe.audible[id] ?? null);
        const all = audible.includes(null) ? null : Math.max(...audible);
        const any = audible.every((at) => at === null) ? null : Math.min(...audible.filter((at) => at !== null));
        row.earlyAll = readyAt !== null && (all === null || readyAt < all);
        row.earlyAny = readyAt !== null && (any === null || readyAt < any);
        row.gapAll = readyAt !== null && all !== null ? readyAt - all : null;
        row.gapAny = readyAt !== null && any !== null ? readyAt - any : null;
        row.neverAudible = all === null;
        cell.cohort.push(row);
      } else cell.empty.push(row);
    }
  }
}
const count = (rows, key) => rows.filter((row) => row[key]).length;
const numbers = (rows, key) => rows.map((row) => row[key]).filter((value) => value !== null);
const ms = (value) => (value === null ? "n/a" : `${Math.round(value)} ms`);
for (const [profile, cell] of cells) {
  const { cohort, empty } = cell;
  console.log(`\n## ${profile}: ${cell.rooms} rooms (${cell.failedRooms} failed)`);
  console.log(
    `cohort joins n=${cohort.length}: ready before every cohort speaker audible ${count(cohort, "earlyAll")}; before the first audible ${count(cohort, "earlyAny")}; never ready ${cohort.filter((row) => row.readyAt === null).length}; degraded at some point ${count(cohort, "degraded")}; left ready ${count(cohort, "regressed")}; some speaker never audible ${count(cohort, "neverAudible")}`,
  );
  console.log(`  ready minus last-speaker-audible: p50 ${ms(quantile(numbers(cohort, "gapAll"), 0.5))}, p95 ${ms(quantile(numbers(cohort, "gapAll"), 0.95))}, n=${numbers(cohort, "gapAll").length}`);
  console.log(`  ready minus first-audible: p50 ${ms(quantile(numbers(cohort, "gapAny"), 0.5))}, p95 ${ms(quantile(numbers(cohort, "gapAny"), 0.95))}, n=${numbers(cohort, "gapAny").length}`);
  console.log(`  join call to ready: p50 ${ms(quantile(numbers(cohort, "toReady"), 0.5))}, p95 ${ms(quantile(numbers(cohort, "toReady"), 0.95))}; join call to live: p50 ${ms(quantile(numbers(cohort, "toLive"), 0.5))}`);
  console.log(
    `empty-room joins n=${empty.length}: never ready ${empty.filter((row) => row.readyAt === null).length}; degraded ${count(empty, "degraded")}; left ready after speakers joined ${count(empty, "regressed")}; join call to ready p50 ${ms(quantile(numbers(empty, "toReady"), 0.5))}, p95 ${ms(quantile(numbers(empty, "toReady"), 0.95))}`,
  );
}
