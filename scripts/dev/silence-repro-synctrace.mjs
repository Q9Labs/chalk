// Usage: node scripts/dev/silence-repro-synctrace.mjs <out-dir>...
// Needs a run made with the temporary Sync logging commit (silence_probe lines in the room's c<N>.log).
// For every unmute tap: the Sync live_target lines for that speaker around the tap (when Sync finished each one, how long applying the target and the reconcile after it took, what outcome it answered), whether the speaker's local POST followed, and whether the client saw its Sync connection drop.
// The speaker's Sync participant id comes from the API access log: the participant ids in the paths of its media requests are matched to the harness's own request records by time.
import { existsSync, readFileSync } from "node:fs";

const windowBeforeMs = 1000;
const windowAfterMs = 16_000;
const quantile = (values, q) => (values.length === 0 ? null : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]);
const seconds = (ms) => (ms === null || ms === undefined ? "-" : (ms / 1000).toFixed(1));
const groups = new Map();
const rows = [];

const parseApi = (text) => {
  const found = [];
  let offset = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("[api] {") || !line.includes('"event":"http.request"')) continue;
    try {
      const event = JSON.parse(line.slice(6));
      offset ??= /([+-]\d\d:\d\d)$/u.exec(event.time)?.[1] ?? null;
      const participant = /\/participants\/([0-9a-f-]{36})\//u.exec(event.path)?.[1];
      if (participant) found.push({ ms: Date.parse(event.time), method: event.method, tail: event.path.split("/").slice(-1)[0], participant });
    } catch {}
  }
  return { requests: found, offset, day: found.length ? new Date(found[0].ms).toISOString().slice(0, 10) : null };
};

const participantIds = (run, requests) => {
  const votes = new Map();
  for (const entry of run.network ?? []) {
    const tail = entry.path.split("/").slice(-1)[0];
    const at = run.originMs + entry.at;
    let best = null;
    for (const request of requests) {
      if (request.method !== entry.method || request.tail !== tail) continue;
      const gap = Math.abs(request.ms - at);
      if (gap < 1500 && (!best || gap < best.gap)) best = { gap, id: request.participant };
    }
    if (!best) continue;
    const tally = votes.get(entry.participant) ?? new Map();
    tally.set(best.id, (tally.get(best.id) ?? 0) + 1);
    votes.set(entry.participant, tally);
  }
  return new Map([...votes].map(([index, tally]) => [index, [...tally].sort((a, b) => b[1] - a[1])[0][0]]));
};

const parseSync = (text, day, offset) => {
  const lines = [];
  for (const line of text.split("\n")) {
    const live = /^(\d\d:\d\d:\d\d\.\d+) \[warning\] silence_probe live_target participant=(\S+) apply_ms=(\d+) reconcile_ms=(\d+) applied="(\w+)" final="(\w+)" error=(\S+) target=(.*)$/u.exec(line);
    if (live) {
      lines.push({ ms: Date.parse(`${day}T${live[1]}${offset}`), kind: "live_target", participant: live[2], applyMs: Number(live[3]), reconcileMs: Number(live[4]), applied: live[5], final: live[6], error: live[7], enabled: live[8].includes("enabled: true") });
      continue;
    }
    const other = /^(\d\d:\d\d:\d\d\.\d+) \[warning\] silence_probe (reconcile_error|media_pauses|media_stops) (.*)$/u.exec(line);
    if (other) lines.push({ ms: Date.parse(`${day}T${other[1]}${offset}`), kind: other[2], detail: other[3].slice(0, 120) });
  }
  return lines;
};

for (const dir of process.argv.slice(2)) {
  const runs = JSON.parse(readFileSync(`${dir}/silence-repro.json`, "utf8")).runs;
  runs.forEach((run, position) => {
    const logPath = `${dir}/c${position + 1}.log`;
    if (!existsSync(logPath)) return;
    const text = readFileSync(logPath, "utf8");
    const api = parseApi(text);
    if (!api.day || !api.offset) return;
    const ids = participantIds(run, api.requests);
    const sync = parseSync(text, api.day, api.offset);
    const build = String(run.build)
      .replace(/^npm:5\.2\.6@/u, "")
      .slice(0, 8);
    for (const action of run.actions ?? []) {
      if (action.kind !== "unmute") continue;
      const speaker = action.participant;
      const tap = action.clickedAtMs;
      const tapAbs = run.originMs + tap;
      const mine = (run.network ?? []).filter((entry) => entry.participant === speaker);
      const local = mine.find((entry) => entry.method === "POST" && entry.path.endsWith("/media/sfu/tracks") && String(entry.locations).includes("local") && entry.at >= tap && entry.at <= tap + 10_000);
      const id = ids.get(speaker);
      const lines = sync.filter((line) => (line.kind === "live_target" ? line.participant === id && line.enabled && line.ms >= tapAbs - windowBeforeMs && line.ms <= tapAbs + windowAfterMs : line.ms >= tapAbs - windowBeforeMs && line.ms <= tapAbs + windowAfterMs));
      const targets = lines.filter((line) => line.kind === "live_target");
      const states = (run.samples ?? []).map((sample) => ({ atMs: sample.atMs, state: sample.states.find((entry) => entry.listener === speaker) })).filter((item) => item.state);
      const statuses = [...new Set(states.filter((item) => item.atMs >= tap - 5000 && item.atMs <= tap + 20_000).map((item) => item.state.status))];
      const reconnected = statuses.some((status) => status !== "live");
      const key = `${build} ${local ? "worked" : "NO POST"}`;
      const group = groups.get(key) ?? groups.set(key, { taps: 0, noParticipant: 0, noTarget: 0, firstResult: new Map(), arrival: [], apply: [], reconcile: [], finals: new Map(), errors: new Map(), reconnected: 0, extra: new Map(), perTap: [] }).get(key);
      group.taps++;
      if (!id) group.noParticipant++;
      if (targets.length === 0) group.noTarget++;
      group.perTap.push(targets.length);
      if (reconnected) group.reconnected++;
      for (const line of lines.filter((item) => item.kind !== "live_target")) group.extra.set(`${line.kind}: ${line.detail}`, (group.extra.get(`${line.kind}: ${line.detail}`) ?? 0) + 1);
      for (const line of targets) {
        group.apply.push(line.applyMs);
        group.reconcile.push(line.reconcileMs);
        group.finals.set(`${line.applied}->${line.final}`, (group.finals.get(`${line.applied}->${line.final}`) ?? 0) + 1);
        if (line.error !== "nil") group.errors.set(line.error, (group.errors.get(line.error) ?? 0) + 1);
      }
      if (targets[0]) group.arrival.push(targets[0].ms - targets[0].applyMs - targets[0].reconcileMs - tapAbs);
      if (!local) {
        rows.push({
          build,
          condition: run.condition,
          speaker,
          tapT: Number(action.t.toFixed(1)),
          participantId: id ? id.slice(0, 8) : null,
          syncLiveTargets: targets.map((line) => ({ finishedAtS: Number(((line.ms - tapAbs) / 1000).toFixed(2)), applyMs: line.applyMs, reconcileMs: line.reconcileMs, applied: line.applied, final: line.final, error: line.error })),
          otherSyncLines: lines.filter((line) => line.kind !== "live_target").map((line) => `${line.kind} ${line.detail}`),
          clientStatusesTapMinus5To20s: statuses,
        });
      }
    }
  });
}

console.log(
  "Per build and outcome: taps; taps with no Sync live_target (enabled:true) in -1..+16 s; live_target lines per tap p50/max; Sync start of first live_target relative to the tap, p50/p95/max (s); apply ms p50/max; reconcile ms p50/max; outcome applied->final; error codes; taps where the client status left live; other probe lines (reconcile errors, media_pauses/media_stops read failures)",
);
for (const [key, group] of [...groups].sort()) {
  console.log(
    `${key}: taps ${group.taps}; no live_target ${group.noTarget} (no participant id ${group.noParticipant}); lines/tap p50 ${quantile(group.perTap, 0.5)} max ${Math.max(...group.perTap)}; first live_target start p50 ${seconds(quantile(group.arrival, 0.5))} p95 ${seconds(quantile(group.arrival, 0.95))} max ${seconds(Math.max(...group.arrival, -Infinity))}; apply ms p50 ${quantile(group.apply, 0.5)} max ${Math.max(...group.apply, 0)}; reconcile ms p50 ${quantile(group.reconcile, 0.5)} max ${Math.max(...group.reconcile, 0)}; outcomes ${[...group.finals].map(([name, count]) => `${name} ${count}`).join(", ") || "-"}; errors ${[...group.errors].map(([name, count]) => `${name} ${count}`).join(", ") || "none"}; client status not live ${group.reconnected}; other ${[...group.extra].map(([name, count]) => `${name} x${count}`).join("; ") || "none"}`,
  );
}
console.log("\nNo-POST taps:");
for (const row of rows) console.log(JSON.stringify(row));
