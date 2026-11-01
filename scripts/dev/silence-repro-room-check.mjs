// Usage: node silence-repro-room-check.mjs [--log=<api log>]... <silence-repro.json>...
// Per build and condition, checks for the mute-cycle room (#757) and the plain room (#721):
//   muter as listener: after its first audible second, every silent episode of each other speaker that lasts REAL_SILENCE or more (a ~4 s gap shows here).
//   muter as speaker: from each unmute tap to each other listener hearing audio (tap-to-heard), and whether the muter's next local publish was accepted.
//   every pair: never audible, longest silent episode while the mic was on, silent at the end of the room.
//   browser console: console errors and page errors, and how many mention Schema, decode or parse.
//   API log: Cloudflare request failures by operation and status.
import { readFileSync } from "node:fs";

const LEVEL = 0.01;
const REAL_SILENCE = 2;
const GAP = 3.5;
const HEARD_LIMIT = 3;
const MUTER = 0;

const args = process.argv.slice(2);
const logs = args.filter((arg) => arg.startsWith("--log=")).map((arg) => arg.slice(6));
const files = args.filter((arg) => !arg.startsWith("--"));

const entryFor = (sample, listener, speaker) => sample.states[listener]?.remote.find((entry) => entry.speaker === speaker);

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

// Silent episodes after the first audible sample; the last one is open when audio never came back.
function laterEpisodes(run, series) {
  const first = series.indexOf(true);
  if (first === -1) return { neverAudible: true, episodes: [] };
  const episodes = [];
  let start = run.samples[first].t;
  for (let i = first + 1; i < run.samples.length; i++) {
    if (!series[i]) continue;
    const t = run.samples[i].t;
    if (t - start > 1.5) episodes.push({ start, end: t, length: t - start, open: false });
    start = t;
  }
  const end = run.samples.at(-1).t;
  if (end - start > 1.5) episodes.push({ start, end, length: end - start, open: true });
  return { neverAudible: false, episodes };
}

const quantile = (list, q) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.ceil(list.length * q) - 1)] : NaN);
const fixed = (value) => (Number.isNaN(value) ? "-" : value.toFixed(1));

const cells = new Map();
for (const file of files) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const run of Array.isArray(data) ? data : (data.runs ?? [data])) {
    if (!run.samples?.length) continue;
    const key = `${run.build} | ${run.condition}`;
    const cell = cells.get(key) ?? {
      rooms: 0,
      errors: 0,
      pairs: 0,
      neverAudible: 0,
      over5: 0,
      silentAtEnd: 0,
      tto: [],
      muterGaps: [],
      muterListenerPairs: 0,
      muterGapRooms: 0,
      unmutes: 0,
      notHeard: 0,
      heard: [],
      blocked: 0,
      publishes: 0,
      publishRejected: 0,
      consoleErrors: new Map(),
      pageErrors: 0,
      schemaLike: 0,
    };
    cells.set(key, cell);
    cell.rooms++;
    if (run.error) cell.errors++;
    const participants = run.samples[0].states.length;
    const speakers = run.speakerCount ?? 4;
    const end = run.samples.at(-1).t;
    let muterGapSeen = false;
    for (let speaker = 0; speaker < speakers; speaker++) {
      for (let listener = 0; listener < participants; listener++) {
        if (listener === speaker) continue;
        const series = audibleSeries(run, listener, speaker);
        const { neverAudible, episodes } = laterEpisodes(run, series);
        // A muted speaker is not expected to be heard, so the muter's own pairs are measured at its unmute taps instead.
        if (speaker === MUTER && run.muteCycle) continue;
        cell.pairs++;
        if (neverAudible) cell.neverAudible++;
        if (episodes.some((episode) => episode.length > 5)) cell.over5++;
        if (!series.slice(-3).some(Boolean)) cell.silentAtEnd++;
        if (listener === MUTER) {
          cell.muterListenerPairs++;
          for (const episode of episodes)
            if (episode.length >= REAL_SILENCE) {
              cell.muterGaps.push({ length: episode.length, speaker, at: episode.start, open: episode.open, room: file });
              if (episode.length >= GAP) muterGapSeen = true;
            }
        }
        const firstTime = series.indexOf(true);
        if (firstTime !== -1) cell.tto.push(run.samples[firstTime].t);
      }
    }
    if (muterGapSeen) cell.muterGapRooms++;
    // Muter as speaker: every unmute tap of the muter, then each other listener's first audible sample after the click, before the next mute tap.
    const muterActions = (run.actions ?? []).filter((action) => action.participant === MUTER).sort((a, b) => a.scheduledT - b.scheduledT);
    muterActions.forEach((action, index) => {
      if (action.kind !== "unmute") return;
      cell.unmutes++;
      if (action.blocked !== undefined) {
        cell.blocked++;
        return;
      }
      const nextMute = muterActions.slice(index + 1).find((later) => later.kind === "mute");
      const until = nextMute?.t ?? end;
      for (let listener = 1; listener < participants; listener++) {
        const series = audibleSeries(run, listener, MUTER);
        const hit = run.samples.findIndex((sample, i) => series[i] && sample.t >= action.t && sample.t < until);
        if (hit === -1) cell.notHeard++;
        else cell.heard.push(run.samples[hit].t - action.t);
      }
      const publish = (run.network ?? []).find((entry) => entry.participant === MUTER && entry.method === "POST" && entry.locations === "local" && entry.at >= action.clickedAtMs);
      if (publish) {
        cell.publishes++;
        if (publish.status >= 300 || publish.trackErrors?.length) cell.publishRejected++;
      }
    });
    for (const fault of run.faults ?? []) {
      if (fault.kind === "pageerror") cell.pageErrors++;
      if (fault.kind === "console-error" || fault.kind === "pageerror") {
        if (/schema|decode|parse/iu.test(fault.message)) cell.schemaLike++;
        const text = fault.message.slice(0, 120);
        cell.consoleErrors.set(text, (cell.consoleErrors.get(text) ?? 0) + 1);
      }
    }
  }
}

console.log("| build | condition | rooms | pairs | never audible | pairs with a gap >5 s | silent at end | time to first audio p50 / max (s) | console + page errors (Schema/decode/parse) |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const [key, cell] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
  const errorCount = [...cell.consoleErrors.values()].reduce((sum, count) => sum + count, 0);
  console.log(`| ${key.replace(" | ", " | ")} | ${cell.rooms} | ${cell.pairs} | ${cell.neverAudible} | ${cell.over5} | ${cell.silentAtEnd} | ${fixed(quantile(cell.tto, 0.5))} / ${fixed(Math.max(...cell.tto))} | ${errorCount} (${cell.schemaLike}) |`);
}
console.log("");
console.log("| build | condition | muter unmutes | tapped but blocked | listener pairs not heard before next mute | tap-to-heard p50 / p99 / max (s) | heard later than 3 s | muter's next local publish accepted / rejected | muter-as-listener gaps >= 2 s (>= 3.5 s) | rooms with a gap >= 3.5 s |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const [key, cell] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
  if (!cell.unmutes) continue;
  const late = cell.heard.filter((value) => value > HEARD_LIMIT).length;
  const gaps = cell.muterGaps.length;
  const big = cell.muterGaps.filter((gap) => gap.length >= GAP).length;
  console.log(
    `| ${key} | ${cell.unmutes} | ${cell.blocked} | ${cell.notHeard} | ${fixed(quantile(cell.heard, 0.5))} / ${fixed(quantile(cell.heard, 0.99))} / ${fixed(Math.max(...cell.heard))} | ${late} of ${cell.heard.length} | ${cell.publishes - cell.publishRejected} / ${cell.publishRejected} | ${gaps} (${big}) | ${cell.muterGapRooms} of ${cell.rooms} |`,
  );
}
for (const [key, cell] of cells) {
  const top = [...cell.consoleErrors].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length) console.log(`\nConsole errors, ${key}:\n${top.map(([text, count]) => `- ${count} x ${text}`).join("\n")}`);
}
for (const path of logs) {
  const failures = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("cloudflare_sfu.request_failed")) continue;
    const operation = /"operation":"([^"]+)"/u.exec(line)?.[1];
    const status = /"http_status":(\d+)/u.exec(line)?.[1] ?? /"failure_stage":"([^"]+)"/u.exec(line)?.[1];
    const key = `${operation} ${status}`;
    failures.set(key, (failures.get(key) ?? 0) + 1);
  }
  console.log(`\nAPI Cloudflare request failures, ${path}: ${[...failures].map(([key, count]) => `${key} x${count}`).join(", ") || "none"}`);
}
