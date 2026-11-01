// Usage: node scripts/dev/silence-repro-pulls.mjs <output-dir>...   (each dir holds silence-repro.json and the API logs c<N>.log, run N = log N)
// Aggregates only, for every browser pull (POST .../media/sfu/tracks with a remote track):
//  (b) gate wait: the API request start to the start of its first Cloudflare call (add_tracks log time minus upstream_latency_ms; for a call that timed out, the failure time minus the 5 s call timeout);
//  (c) pulls that ended in a Cloudflare transport timeout, split by listener session age (older than 15 s, no earlier 2xx tracks answer on that connection) and by first call versus retry after a session swap
//      (a media.connection_replacement inside the request window precedes the retry). For those, the time from request start to the final Cloudflare call start says what used the first seconds.
// A browser entry is matched to its API http.request by status and response time (within 150 ms); the API trace_id is shared by a participant's whole session, so Cloudflare events are matched by trace_id and the request window.
import { readFileSync } from "node:fs";

const callTimeoutMs = 5000;
const sessionAgeLimitMs = 15_000;
const quantile = (values, q) => (values.length === 0 ? null : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]);
const fmt = (value) => (value === null ? "-" : (value / 1000).toFixed(1));
const parseLog = (path) => {
  const events = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("{");
    if (at < 0) continue;
    try {
      const json = JSON.parse(line.slice(at));
      json.ms = Date.parse(json.time);
      events.push(json);
    } catch {}
  }
  return events;
};

for (const dir of process.argv.slice(2)) {
  const result = JSON.parse(readFileSync(`${dir}/silence-repro.json`, "utf8"));
  const gate = [];
  const timeouts = new Map();
  const usage = { prior: new Map(), toFinal: [], cases: 0 };
  const noPost = { taps: 0, cases: 0, inFlight: [], rows: [], mic: new Map() };
  let pulls = 0;
  let matched = 0;
  result.runs.forEach((run, index) => {
    let events;
    try {
      events = parseLog(`${dir}/c${index + 1}.log`);
    } catch {
      return;
    }
    const requests = events.filter((event) => event.event === "http.request" && event.route?.endsWith("/media/sfu/tracks"));
    const cloudflare = new Map();
    const replacements = new Map();
    for (const event of events) {
      if (event.event?.startsWith("cloudflare_sfu.")) (cloudflare.get(event.trace_id) ?? cloudflare.set(event.trace_id, []).get(event.trace_id)).push(event);
      if (event.event === "media.connection_replacement") (replacements.get(event.trace_id) ?? replacements.set(event.trace_id, []).get(event.trace_id)).push(event);
    }
    const entries = (run.network ?? []).filter((entry) => entry.method === "POST" && entry.path.endsWith("/media/sfu/tracks") && String(entry.locations).includes("remote"));
    for (const entry of entries) {
      pulls++;
      const done = run.originMs + entry.at;
      const request = requests.find((candidate) => candidate.status === entry.status && Math.abs(candidate.ms - done) < 150);
      if (!request) continue;
      matched++;
      const start = request.ms - request.duration_ms;
      const inside = (cloudflare.get(request.trace_id) ?? []).filter((event) => event.ms >= start - 5 && event.ms <= request.ms + 5);
      const swaps = (replacements.get(request.trace_id) ?? []).filter((event) => event.ms >= start - 5 && event.ms <= request.ms + 5);
      const callStarts = inside.flatMap((event) => (event.event === "cloudflare_sfu.add_tracks" && event.upstream_latency_ms !== undefined ? [event.ms - event.upstream_latency_ms] : event.failure_stage === "transport" && event.transport_cause === "timeout" ? [event.ms - callTimeoutMs] : []));
      if (callStarts.length > 0) gate.push(Math.min(...callStarts) - start);
      const timeout = inside.filter((event) => event.event === "cloudflare_sfu.request_failed" && event.transport_cause === "timeout").at(-1);
      if (!timeout) continue;
      const firstEntryOfConnection = Math.min(...(run.network ?? []).filter((other) => other.participant === entry.participant && other.connectionNumber === entry.connectionNumber).map((other) => other.at));
      const earlierAnswer = (run.network ?? []).some((other) => other.participant === entry.participant && other.connectionNumber === entry.connectionNumber && other.status < 300 && other.at < entry.at - request.duration_ms && other.method === "POST" && other.path.endsWith("/media/sfu/tracks"));
      const age = entry.at - request.duration_ms - firstEntryOfConnection;
      const sessionClass = age > sessionAgeLimitMs && !earlierAnswer ? "older than 15 s, never answered" : "younger or already used";
      const retry = swaps.length > 0 && swaps.some((swap) => swap.ms < timeout.ms - callTimeoutMs + 50) ? "retry after session swap" : "first call";
      const bucket = request.duration_ms > 7000 ? "~8 s request" : "~6 s request";
      const key = `${bucket} | ${sessionClass} | ${retry}`;
      timeouts.set(key, (timeouts.get(key) ?? 0) + 1);
      if (request.duration_ms > 7000) {
        usage.cases++;
        usage.toFinal.push(timeout.ms - callTimeoutMs - start);
        const finalStart = timeout.ms - callTimeoutMs;
        const prior = [...inside.filter((event) => event !== timeout && event.ms <= finalStart + 50).map((event) => event.event.replace("cloudflare_sfu.", "")), ...swaps.filter((swap) => swap.ms <= finalStart + 50).map(() => "session swap")];
        const priorKey = prior.length === 0 ? "nothing logged before the final call (gate hold)" : [...new Set(prior)].sort().join(" + ");
        usage.prior.set(priorKey, (usage.prior.get(priorKey) ?? 0) + 1);
      }
    }
    // (a) unmute taps with no local POST within 10 s: the speaker's /tracks requests in flight at the tap (start offset, duration, status), start taken from the browser or, failing that, the API request window.
    const trackEntries = (run.network ?? []).filter((entry) => entry.method === "POST" && entry.path.endsWith("/media/sfu/tracks"));
    const windows = trackEntries.map((entry) => {
      const request = requests.find((candidate) => candidate.status === entry.status && Math.abs(candidate.ms - (run.originMs + entry.at)) < 150);
      const started = entry.startedAt ?? (request ? entry.at - request.duration_ms : null);
      return { entry, started };
    });
    for (const action of run.actions ?? []) {
      if (action.kind !== "unmute") continue;
      noPost.taps++;
      const tap = action.clickedAtMs;
      const mine = windows.filter((item) => item.entry.participant === action.participant);
      if (mine.some((item) => String(item.entry.locations).includes("local") && item.entry.at >= tap && item.entry.at <= tap + 10_000)) continue;
      noPost.cases++;
      const inFlight = mine.filter((item) => item.started !== null && item.started <= tap && item.entry.at >= tap);
      noPost.inFlight.push(inFlight.length);
      for (const item of inFlight) noPost.rows.push(`first ${action.first ? "yes" : "no"} tap ${action.t.toFixed(1)}s: ${String(item.entry.locations)} start ${((item.started - tap) / 1000).toFixed(1)}s duration ${((item.entry.at - item.started) / 1000).toFixed(1)}s status ${item.entry.status}`);
      const last = (run.samples ?? [])
        .map((sample) => sample.states.find((state) => state.listener === action.participant))
        .filter(Boolean)
        .at(-1);
      noPost.mic.set(String(last?.mic ?? "unknown"), (noPost.mic.get(String(last?.mic ?? "unknown")) ?? 0) + 1);
    }
  });
  console.log(`## ${dir}: browser pulls ${pulls}, matched to API requests ${matched}`);
  console.log(`   (b) gate wait to first Cloudflare call, s: n ${gate.length} p50 ${fmt(quantile(gate, 0.5))} p95 ${fmt(quantile(gate, 0.95))} max ${fmt(Math.max(...gate, 0))}; over 1 s: ${gate.filter((value) => value > 1000).length}`);
  console.log(`   (c) pull transport timeouts by class:`);
  for (const [key, count] of [...timeouts].sort((a, b) => b[1] - a[1])) console.log(`       ${count}\t${key}`);
  console.log(`   (c) ~8 s timeouts: ${usage.cases}; request start to final Cloudflare call start, s: p50 ${fmt(quantile(usage.toFinal, 0.5))} p95 ${fmt(quantile(usage.toFinal, 0.95))}; what ran before the final call:`);
  for (const [key, count] of [...usage.prior].sort((a, b) => b[1] - a[1])) console.log(`       ${count}\t${key}`);
  console.log(
    `   (a) unmute taps ${noPost.taps}; with no local POST tracks within 10 s: ${noPost.cases}; of those with a /tracks request in flight at the tap: ${noPost.inFlight.filter((count) => count > 0).length}; mic at end: ${[...noPost.mic].map(([state, count]) => `${state} ${count}`).join(", ") || "-"}`,
  );
  for (const row of noPost.rows) console.log(`       ${row}`);
}
