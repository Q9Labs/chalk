// Usage: node scripts/dev/silence-repro-nopost-trace.mjs <silence-repro.json>...
// Per unmute tap, what the speaker's client did after the tap, for taps with no local POST /media/sfu/tracks within 10 s (no-POST) and for taps that worked.
// Sources: clickTrace (the page's own record of the setMicrophoneEnabled call: start, end, result), the speaker's media requests, and the per-second status/mic samples.
import { readFileSync } from "node:fs";

const windowMs = 10_000;
const quantile = (values, q) => (values.length === 0 ? null : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]);
const seconds = (ms) => (ms === null || ms === undefined ? "-" : (ms / 1000).toFixed(1));
const groups = new Map();
const rows = [];
for (const file of process.argv.slice(2)) {
  for (const run of JSON.parse(readFileSync(file, "utf8")).runs) {
    const network = run.network ?? [];
    const build = String(run.build)
      .replace(/^npm:5\.2\.6@/u, "")
      .slice(0, 8);
    for (const action of run.actions ?? []) {
      if (action.kind !== "unmute") continue;
      const speaker = action.participant;
      const tap = action.clickedAtMs;
      const mine = network.filter((entry) => entry.participant === speaker);
      const local = mine.find((entry) => entry.method === "POST" && entry.path.endsWith("/media/sfu/tracks") && String(entry.locations).includes("local") && entry.at >= tap && entry.at <= tap + windowMs);
      const trace = (run.clickTrace?.[speaker] ?? []).filter((item) => item.kind === "setMicrophoneEnabled" && item.args?.[0] === true);
      const call = trace
        .map((item) => ({ item, offset: item.at - run.originMs - tap }))
        .filter(({ offset }) => offset >= -300 && offset <= 1500)
        .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0]?.item;
      const result = !call ? "no call recorded" : call.endAt === undefined ? "still pending at run end" : call.ok ? "ok" : `error: ${call.error}`;
      const callMs = call?.endAt === undefined ? null : call.endAt - call.at;
      const states = (run.samples ?? []).map((sample) => ({ atMs: sample.atMs, state: sample.states.find((entry) => entry.listener === speaker) })).filter((item) => item.state);
      const around = states.filter((item) => item.atMs >= tap - 5000 && item.atMs <= tap + 20_000);
      const notLive = around.filter((item) => item.state.status !== "live").map((item) => item.state.status);
      const last = states.at(-1)?.state;
      const pulls = mine.filter((entry) => entry.method === "POST" && entry.path.endsWith("/media/sfu/tracks") && String(entry.locations).includes("remote") && entry.startedAt != null && entry.startedAt <= tap && entry.at >= tap).length;
      const key = `${build} ${local ? "worked" : "NO POST"}`;
      const group = groups.get(key) ?? groups.set(key, { taps: 0, results: new Map(), toPost: [], callMs: [], notLive: 0 }).get(key);
      group.taps++;
      group.results.set(result, (group.results.get(result) ?? 0) + 1);
      if (local) group.toPost.push(local.at - tap);
      if (callMs !== null) group.callMs.push(callMs);
      if (notLive.length) group.notLive++;
      if (!local) {
        const requests = mine.filter((entry) => entry.at >= tap - 1000 && entry.at <= tap + 15_000).map((entry) => `${entry.method} ${entry.path.split("/").slice(-2).join("/")} ${entry.status} @${seconds(entry.at - tap)}s`);
        rows.push({
          build,
          condition: run.condition,
          speaker,
          tapT: Number(action.t.toFixed(1)),
          first: action.first,
          call: result,
          callSeconds: seconds(callMs),
          mediaRequests: requests,
          statusNotLive: [...new Set(notLive)],
          micAtEnd: last?.mic,
          commandErrors: [...new Set(around.map((item) => item.state.commandError?.code).filter(Boolean))],
          inFlightPullsAtTap: pulls,
        });
      }
    }
  }
}
console.log("Per build and outcome: taps, how the setMicrophoneEnabled(true) call ended, tap to local POST (s) p50/p95 for taps that worked, call duration p50/p95 (s), taps with the speaker's Sync/SFU status not live within -5..+20 s");
for (const [key, group] of [...groups].sort()) {
  console.log(
    `${key}: taps ${group.taps}; call: ${[...group.results].map(([result, count]) => `${result} ${count}`).join(", ")}; tap to POST p50 ${seconds(quantile(group.toPost, 0.5))} p95 ${seconds(quantile(group.toPost, 0.95))}; call ms p50 ${seconds(quantile(group.callMs, 0.5))} p95 ${seconds(quantile(group.callMs, 0.95))}; status not live ${group.notLive}`,
  );
}
console.log("\nNo-POST taps:");
for (const row of rows) console.log(JSON.stringify(row));
