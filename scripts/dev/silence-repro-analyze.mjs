// Usage: node silence-repro-analyze.mjs [--json] <silence-repro.json>... ; one row per build and condition.
//
// A listener-speaker pair is observed from the speaker's mic reaching "enabled" until the speaker's next mute (or the end of
// the run). A second counts as audible when the listener's inbound bytes rose and audioLevel was above 0.01.
//   silent: not audible within 15 s of enabled.
//   heal time of a pair: its longest silent episode while the mic stayed enabled. The first episode runs from enabled to the
//   first audible second (time to audio); later episodes start when audio stops and end when it comes back. An episode still
//   open at the end of the observation counts up to that end, so the number is a lower bound.
// Pairs in one room and one unmute share fate, so intervals come from resampling unmutes, not pairs. The Wilson interval
// treats pairs as independent and is shown for comparison only.
import { readFileSync } from "node:fs";

const DEADLINE = 15;
const TOGGLE_DEADLINE = 7;
const LEVEL = 0.01;
const SLOW = 5;
const BOOTSTRAPS = 4000;
const stages = ["not in roster", "in roster, no remote publication", "publication but track missing or ended", "live track, no bytes", "bytes flowing, audioLevel 0", "audible but element unbound/paused/not playing"];

const entryFor = (sample, listener, speaker) => sample.states[listener]?.remote.find((entry) => entry.speaker === speaker);

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

// One boolean per sample: was this pair audible during the second before that sample.
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

// Silent episodes between `from` and `to`, as { start, end, open }.
function silentEpisodes(run, series, from, to) {
  const episodes = [];
  let start = from;
  let last = from;
  for (let i = 0; i < run.samples.length; i++) {
    const t = run.samples[i].t;
    if (t < from || t >= to) continue;
    last = t;
    if (series[i]) {
      if (t > start) episodes.push({ start, end: t, open: false });
      start = t;
    }
  }
  if (last > start) episodes.push({ start, end: last, open: true });
  return episodes;
}

const wilson = (k, n) => {
  if (!n) return [NaN, NaN];
  const z = 1.96;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
};

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Percentile interval of the pair-weighted rate when whole clusters (one unmute each) are resampled.
function clusterInterval(clusters, field) {
  const total = clusters.reduce((sum, cluster) => sum + cluster.pairs, 0);
  if (!total) return [NaN, NaN];
  const random = seeded(12345);
  const rates = [];
  for (let b = 0; b < BOOTSTRAPS; b++) {
    let k = 0;
    let n = 0;
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      k += cluster[field];
      n += cluster.pairs;
    }
    rates.push(k / n);
  }
  rates.sort((a, b) => a - b);
  return [rates[Math.floor(BOOTSTRAPS * 0.025)], rates[Math.floor(BOOTSTRAPS * 0.975)]];
}

const quantile = (list, q) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.ceil(list.length * q) - 1)] : NaN);

// Times (ms since run start) at which a participant's SFU session changed after its first one.
function sessionChanges(run, participant) {
  const times = [];
  let highest = 0;
  for (const entry of run.network) {
    if (entry.participant !== participant || !entry.connectionNumber) continue;
    if (entry.connectionNumber > highest) {
      if (highest > 0) times.push(entry.at);
      highest = entry.connectionNumber;
    }
  }
  return times;
}
const REAL_SILENCE = 2; // seconds; the 1 s sampling makes anything shorter a normal join or heal

// Harness load per room: box CPU busy and steal over the join phase (first 40 s) and the load average peak.
function roomLoad(run) {
  const withCpu = run.samples.filter((sample) => sample.cpu);
  if (!withCpu.length) return null;
  const phase = withCpu.filter((sample) => sample.t <= 40);
  const delta = (list) => {
    const [a, b] = [list[0].cpu.jiffies, list.at(-1).cpu.jiffies];
    const total = b[0] - a[0];
    return total > 0 ? { busy: 1 - (b[1] - a[1]) / total, steal: (b[2] - a[2]) / total } : { busy: NaN, steal: NaN };
  };
  const join = delta(phase);
  return { busy: join.busy, steal: join.steal, load1Max: Math.max(...withCpu.map((sample) => sample.cpu.load1)) };
}
// ICE connect time of the room's receive connections: from the first SFU offer to ice:connected.
function iceConnect(run) {
  const times = [];
  for (const timelines of run.peerTimelines ?? [])
    for (const line of timelines ?? []) {
      const offer = line.find(([name]) => name === "setRemote:offer")?.[1];
      const connected = line.find(([name]) => name === "ice:connected")?.[1];
      if (offer !== undefined && connected !== undefined && connected >= offer) times.push(connected - offer);
    }
  return times;
}
const rooms = [];

const cells = new Map();
const failures = [];
const slowExamples = [];
const files = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const asJson = process.argv.includes("--json");
// --only=v1 keeps rooms whose taps were blind clicks on the mic toggle; --only=v2 keeps rooms whose taps wait for the button to offer the action.
const only = process.argv.find((argument) => argument.startsWith("--only="))?.slice(7);
files.forEach((file, fileIndex) => {
  const report = JSON.parse(readFileSync(file, "utf8"));
  for (const run of report.runs) {
    if (only && (run.harness === "ui-ready-v2" ? "v2" : "v1") !== only) continue;
    const key = `${run.build} | ${run.condition}`;
    const cell = cells.get(key) ?? {
      build: run.build,
      condition: run.condition,
      runs: 0,
      errored: 0,
      stalled: 0,
      pairs: 0,
      silent: 0,
      slow: 0,
      clusters: [],
      timeToAudio: [],
      worst: [],
      neverEnabled: 0,
      unmutes: 0,
      speakerDeaf: 0,
      stagesSilent: new Map(),
      // Tap-to-heard: from the unmute tap to each listener hearing audio; an unmute whose publisher never reaches enabled counts every listener as silent.
      tap: { taps: 0, neverEnabled: 0, neverStatus: new Map(), pairs: 0, silent: 0, slow: 0, clusters: [], worst: [], heard: [], blocked: 0, waited: [] },
      reconnect: { pairs: 0, silent: 0, slow: 0, openAtEnd: 0, worst: [] },
      pulls: 0,
      trackErrors: 0,
      s503: 0,
      injected503: 0,
      listenerKills: 0,
      listenerKillsClosed: 0,
      kills: 0,
      first: { pairs: 0, silent: 0 },
      again: { pairs: 0, silent: 0 },
      shas: new Set(),
    };
    cells.set(key, cell);
    cell.runs++;
    cell.shas.add(`${run.serverSha?.slice(0, 9)}/${run.sdkSha?.slice(0, 9)}`);
    if (run.stalls?.length) {
      cell.stalled++; // the box froze mid-room; its timings are not comparable
      continue;
    }
    if (run.error || !run.samples.length) {
      cell.errored++;
      continue;
    }
    cell.kills += run.kills.length;
    cell.injected503 += run.injected503?.length ?? 0;
    cell.listenerKills += run.listenerKills?.length ?? 0;
    cell.listenerKillsClosed += run.listenerKills?.filter((event) => event.closeStatus && event.closeStatus < 300).length ?? 0;
    for (const entry of run.network) {
      if (entry.method === "POST" && entry.locations === "remote") {
        cell.pulls++;
        if (entry.trackErrors?.length) cell.trackErrors++;
      }
      if (entry.status === 503) cell.s503++;
    }
    const roomBefore = { taps: cell.tap.taps, never: cell.tap.neverEnabled, pairs: cell.tap.pairs, slow: cell.tap.slow };
    const n = run.samples[0].states.length;
    const lastT = run.samples.at(-1).t;
    const byParticipant = new Map();
    for (const action of run.actions) byParticipant.set(action.participant, [...(byParticipant.get(action.participant) ?? []), action]);
    for (const [speaker, actions] of byParticipant) {
      actions.forEach((action, i) => {
        if (action.kind !== "unmute" || action.error) return;
        const next = actions[i + 1]?.t ?? Infinity;
        const end = Math.min(next, lastT + 1e-6);
        const deadline = run.toggle ? TOGGLE_DEADLINE : DEADLINE; // toggle rooms hold the mic open for 8 s only
        if (end - action.t < deadline) return; // censored: the run or the next mute came before the deadline
        cell.unmutes++;
        cell.tap.taps++;
        const tapCluster = { pairs: 0, silent: 0, slow: 0 };
        if (action.waitedMs !== undefined) cell.tap.waited.push(action.waitedMs / 1000);
        if (action.blocked !== undefined) cell.tap.blocked++;
        const enabled = action.blocked !== undefined ? undefined : run.samples.find((sample) => sample.t >= action.t && sample.t <= action.t + deadline && sample.states[speaker]?.mic === "enabled");
        if (!enabled) {
          cell.neverEnabled++; // the publisher itself never reached enabled: not a listener-side failure
          cell.tap.neverEnabled++;
          const tapState = run.samples.find((sample) => sample.t >= action.t)?.states[speaker];
          const label = action.blocked !== undefined ? `blocked 10 s, button offered ${JSON.stringify(action.blocked)}` : `${tapState?.status}/${tapState?.mic}`;
          cell.tap.neverStatus.set(label, (cell.tap.neverStatus.get(label) ?? 0) + 1);
          for (let listener = 0; listener < n; listener++) {
            if (listener === speaker) continue;
            cell.tap.pairs++;
            cell.tap.silent++;
            cell.tap.slow++;
            cell.tap.worst.push(deadline);
            tapCluster.pairs++;
            tapCluster.silent++;
            tapCluster.slow++;
          }
          cell.tap.clusters.push(tapCluster);
          return;
        }
        const cluster = { pairs: 0, silent: 0, slow: 0 };
        let anyListener = false;
        for (let listener = 0; listener < n; listener++) {
          if (listener === speaker) continue;
          const series = audibleSeries(run, listener, speaker);
          const firstAudible = run.samples.findIndex((sample, index) => series[index] && sample.t >= enabled.t && sample.t < end);
          const heard = firstAudible === -1 ? null : run.samples[firstAudible].t - enabled.t;
          const silent = heard === null || heard > deadline;
          const episodes = silentEpisodes(run, series, enabled.t, end);
          const worst = episodes.reduce((max, episode) => Math.max(max, episode.end - episode.start), 0);
          const changes = [...sessionChanges(run, listener), ...sessionChanges(run, speaker)];
          const atMs = (seconds) => run.samples.find((sample) => sample.t >= seconds)?.atMs ?? Infinity;
          const reconnected = episodes.filter((episode) => episode.end - episode.start > REAL_SILENCE && changes.some((time) => time >= atMs(episode.start) - 3000 && time <= atMs(episode.end) + 1000));
          if (reconnected.length) {
            cell.reconnect.pairs++;
            cell.reconnect.worst.push(worst);
            if (worst > SLOW) cell.reconnect.slow++;
            if (heard === null || heard > deadline) cell.reconnect.silent++;
            if (reconnected.some((episode) => episode.open)) cell.reconnect.openAtEnd++;
          }
          const tapFirst = run.samples.findIndex((sample, index) => series[index] && sample.t >= action.t && sample.t < end);
          const tapHeard = tapFirst === -1 ? null : run.samples[tapFirst].t - action.t;
          const tapWorst = Math.max(worst, tapHeard ?? end - action.t);
          cell.tap.pairs++;
          tapCluster.pairs++;
          cell.tap.worst.push(tapWorst);
          if (tapHeard !== null) cell.tap.heard.push(tapHeard);
          if (tapHeard === null || tapHeard > deadline) {
            cell.tap.silent++;
            tapCluster.silent++;
          }
          if (tapWorst > SLOW) {
            cell.tap.slow++;
            tapCluster.slow++;
          }
          const bucket = action.first ? cell.first : cell.again;
          cell.pairs++;
          bucket.pairs++;
          cluster.pairs++;
          cell.worst.push(worst);
          if (worst > SLOW) {
            const longest = episodes.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
            slowExamples.push({ key, file: fileIndex, runIndex: run.runIndex, speaker, listener, unmuteT: action.t, first: action.first, episodeStart: longest.start, seconds: longest.end - longest.start, open: longest.open });
            cell.slow++;
            cluster.slow++;
          }
          if (silent) {
            cell.silent++;
            bucket.silent++;
            cluster.silent++;
            let best = 0;
            run.samples.forEach((sample) => {
              if (sample.t >= enabled.t && sample.t <= enabled.t + deadline) best = Math.max(best, stageAt(sample, listener, speaker));
            });
            const label = stages[Math.min(best, 5)];
            cell.stagesSilent.set(label, (cell.stagesSilent.get(label) ?? 0) + 1);
            failures.push({ key, file: fileIndex, runIndex: run.runIndex, speaker, listener, t: action.t, first: action.first, bestStage: label });
          } else {
            cell.timeToAudio.push(heard);
            anyListener = true;
          }
        }
        if (!anyListener) cell.speakerDeaf++;
        cell.clusters.push(cluster);
        cell.tap.clusters.push(tapCluster);
      });
    }
    rooms.push({
      key,
      participants: n,
      load: roomLoad(run),
      ice: iceConnect(run),
      taps: cell.tap.taps - roomBefore.taps,
      never: cell.tap.neverEnabled - roomBefore.never,
      pairs: cell.tap.pairs - roomBefore.pairs,
      slow: cell.tap.slow - roomBefore.slow,
    });
  }
});

const pct = (value) => (Number.isNaN(value) ? "-" : `${(100 * value).toFixed(1)}%`);
const interval = ([low, high]) => `${pct(low)}–${pct(high)}`;
const seconds = (value) => (Number.isNaN(value) ? "-" : value.toFixed(1));
const rows = [...cells.values()].sort((a, b) => `${a.build}|${a.condition}`.localeCompare(`${b.build}|${b.condition}`));
const summaries = rows.map((cell) => ({
  build: cell.build,
  condition: cell.condition,
  rooms: cell.runs - cell.errored - cell.stalled,
  stalledRooms: cell.stalled,
  erroredRooms: cell.errored,
  unmutes: cell.clusters.length,
  pairs: cell.pairs,
  silent: cell.silent,
  silentRate: cell.pairs ? cell.silent / cell.pairs : NaN,
  silentWilson: wilson(cell.silent, cell.pairs),
  silentCluster: clusterInterval(cell.clusters, "silent"),
  slow: cell.slow,
  slowRate: cell.pairs ? cell.slow / cell.pairs : NaN,
  slowWilson: wilson(cell.slow, cell.pairs),
  slowCluster: clusterInterval(cell.clusters, "slow"),
  timeToAudioP50: quantile(cell.timeToAudio, 0.5),
  healP50: quantile(cell.worst, 0.5),
  healP99: quantile(cell.worst, 0.99),
  healMax: quantile(cell.worst, 1),
  tap: {
    taps: cell.tap.taps,
    neverEnabled: cell.tap.neverEnabled,
    blocked: cell.tap.blocked,
    waitP50: quantile(cell.tap.waited, 0.5),
    waitP99: quantile(cell.tap.waited, 0.99),
    waitMax: quantile(cell.tap.waited, 1),
    neverStatus: Object.fromEntries(cell.tap.neverStatus),
    pairs: cell.tap.pairs,
    silent: cell.tap.silent,
    silentCluster: clusterInterval(cell.tap.clusters, "silent"),
    slow: cell.tap.slow,
    slowCluster: clusterInterval(cell.tap.clusters, "slow"),
    heardP50: quantile(cell.tap.heard, 0.5),
    worstP50: quantile(cell.tap.worst, 0.5),
    worstP99: quantile(cell.tap.worst, 0.99),
    worstMax: quantile(cell.tap.worst, 1),
  },
  speakersHeardByNobody: cell.speakerDeaf,
  publisherNeverEnabled: cell.neverEnabled,
  unmutesAnalysed: cell.unmutes,
  firstUnmuteSilent: `${cell.first.silent}/${cell.first.pairs}`,
  reUnmuteSilent: `${cell.again.silent}/${cell.again.pairs}`,
  pulls: cell.pulls,
  pullsWithTrackErrors: cell.trackErrors,
  injected503: cell.injected503,
  listenerKills: `${cell.listenerKillsClosed}/${cell.listenerKills}`,
  publisherKills: cell.kills,
  builds: [...cell.shas].join(" "),
  stagesSilent: Object.fromEntries(cell.stagesSilent),
  reconnect: {
    pairs: cell.reconnect.pairs,
    silent: cell.reconnect.silent,
    slow: cell.reconnect.slow,
    openAtEnd: cell.reconnect.openAtEnd,
    healP50: quantile(cell.reconnect.worst, 0.5),
    healP99: quantile(cell.reconnect.worst, 0.99),
    healMax: cell.reconnect.worst.length ? Math.max(...cell.reconnect.worst) : NaN,
  },
}));
if (asJson) {
  console.log(JSON.stringify(summaries, null, 1));
} else {
  console.log("| build | condition | rooms | pairs | silent (15 s) | silent rate, cluster 95% | Wilson 95% | pairs silent >5 s | >5 s rate, cluster 95% | time to audio p50 | heal p50 / p99 / max | never enabled | heard by nobody |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries)
    console.log(
      `| ${s.build} | ${s.condition} | ${s.rooms} | ${s.pairs} | ${s.silent} | ${pct(s.silentRate)} (${interval(s.silentCluster)}) | ${interval(s.silentWilson)} | ${s.slow} | ${pct(s.slowRate)} (${interval(s.slowCluster)}) | ${seconds(s.timeToAudioP50)} s | ${seconds(s.healP50)} / ${seconds(s.healP99)} / ${seconds(s.healMax)} s | ${s.publisherNeverEnabled} of ${s.unmutesAnalysed} | ${s.speakersHeardByNobody} |`,
    );
  const noFault = rooms.filter((room) => room.load && /\| (open|home|mobile)$/u.test(room.key) && room.pairs);
  if (noFault.length) {
    const rank = (values) => values.map((value) => values.filter((other) => other < value).length + (values.filter((other) => other === value).length - 1) / 2);
    const correlation = (x, y) => {
      const [rx, ry] = [rank(x), rank(y)];
      const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
      const [mx, my] = [mean(rx), mean(ry)];
      const num = rx.reduce((sum, value, i) => sum + (value - mx) * (ry[i] - my), 0);
      const den = Math.sqrt(rx.reduce((sum, value) => sum + (value - mx) ** 2, 0) * ry.reduce((sum, value) => sum + (value - my) ** 2, 0));
      return den ? num / den : NaN;
    };
    const slowShare = noFault.map((room) => room.slow / room.pairs);
    console.log("\nHarness load check (rooms with no fault and CPU data; busy and steal are the box CPU over the first 40 s):\n");
    console.log("| build | condition | participants | busy | steal | load1 peak | ICE p50 / p90 (ms, n) | taps never enabled | pairs >5 s from tap |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const room of noFault)
      console.log(
        `| ${room.key.replace(" | ", " | ")} | ${room.participants} | ${pct(room.load.busy)} | ${pct(room.load.steal)} | ${room.load.load1Max.toFixed(1)} | ${room.ice.length ? `${quantile(room.ice, 0.5)} / ${quantile(room.ice, 0.9)} (${room.ice.length})` : "-"} | ${room.never} of ${room.taps} | ${room.slow} of ${room.pairs} |`,
      );
    console.log(
      `\nRank correlation across ${noFault.length} rooms: busy vs share of pairs >5 s ${correlation(
        noFault.map((room) => room.load.busy),
        slowShare,
      ).toFixed(2)}; steal vs share ${correlation(
        noFault.map((room) => room.load.steal),
        slowShare,
      ).toFixed(2)}; busy vs share of taps never enabled ${correlation(
        noFault.map((room) => room.load.busy),
        noFault.map((room) => room.never / room.taps),
      ).toFixed(2)}.`,
    );
  }
  console.log("\nTap-to-heard (from the unmute tap to each listener hearing audio; a tap whose publisher never reaches enabled makes every listener pair silent for the whole window):\n");
  console.log("| build | condition | taps | taps never enabled (of which blocked 10 s) | UI wait before tap p50 / p99 / max | pairs | silent at deadline, cluster 95% | pairs >5 s, cluster 95% | tap-to-heard p50 | worst p50 / p99 / max |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries)
    console.log(
      `| ${s.build} | ${s.condition} | ${s.tap.taps} | ${s.tap.neverEnabled} (${s.tap.blocked}) | ${seconds(s.tap.waitP50)} / ${seconds(s.tap.waitP99)} / ${seconds(s.tap.waitMax)} s | ${s.tap.pairs} | ${s.tap.silent} ${pct(s.tap.pairs ? s.tap.silent / s.tap.pairs : NaN)} (${interval(s.tap.silentCluster)}) | ${s.tap.slow} ${pct(s.tap.pairs ? s.tap.slow / s.tap.pairs : NaN)} (${interval(s.tap.slowCluster)}) | ${seconds(s.tap.heardP50)} s | ${seconds(s.tap.worstP50)} / ${seconds(s.tap.worstP99)} / ${seconds(s.tap.worstMax)} s |`,
    );
  console.log("\nPairs that went through a reconnect (a silent episode over 2 s that overlaps an SFU session change of the listener or the speaker):\n");
  console.log("| build | condition | reconnected pairs | silent (15 s) | silent >5 s | still silent at run end | heal p50 / p99 / max |");
  console.log("|---|---|---|---|---|---|---|");
  for (const s of summaries) console.log(`| ${s.build} | ${s.condition} | ${s.reconnect.pairs} | ${s.reconnect.silent} | ${s.reconnect.slow} | ${s.reconnect.openAtEnd} | ${seconds(s.reconnect.healP50)} / ${seconds(s.reconnect.healP99)} / ${seconds(s.reconnect.healMax)} s |`);
  for (const s of summaries) {
    console.log(
      `\n${s.build} | ${s.condition}: rooms dropped for a stall ${s.stalledRooms}, errored ${s.erroredRooms}, first-unmute silent ${s.firstUnmuteSilent}, re-unmute silent ${s.reUnmuteSilent}, pulls ${s.pulls} (track errors ${s.pullsWithTrackErrors}, injected 503 ${s.injected503}), listener kills closed ${s.listenerKills}, publisher kills ${s.publisherKills}, shas ${s.builds}`,
    );
    if (s.tap.neverEnabled) console.log(`  taps that never reached enabled, by speaker status/mic at the tap: ${JSON.stringify(s.tap.neverStatus)}`);
    for (const [stage, count] of Object.entries(s.stagesSilent)) console.log(`  silent pairs by furthest stage: ${stage}: ${count}`);
  }
  console.log("\nFirst silent examples:");
  for (const failure of failures.slice(0, 8)) console.log(JSON.stringify(failure));
  console.log("\nLongest silent episodes:");
  for (const slow of slowExamples.sort((a, b) => b.seconds - a.seconds).slice(0, 8)) console.log(JSON.stringify(slow));
}
