// Usage: node silence-repro-connect.mjs <silence-repro.json>...
// Per receive connection: time from the first SFU offer to each connection milestone, as p50 / p90 / max over connections.
import { readFileSync } from "node:fs";

const milestones = ["gathering:complete", "candidate:end", "ice:checking", "ice:connected", "conn:connected", "dtls:connected", "first-rtp"];
const quantile = (list, q) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.ceil(list.length * q) - 1)];
const at = (line, name, from) => line.find(([entry, ms]) => entry === name && ms >= from)?.[1];

const deltas = new Map(milestones.map((name) => [name, []]));
let connections = 0;
for (const file of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  for (const run of report.runs) {
    for (const timelines of run.peerTimelines ?? []) {
      for (const line of timelines) {
        const offer = at(line, "setRemote:offer", 0);
        if (offer === undefined || at(line, "first-rtp", 0) === undefined) continue;
        connections++;
        for (const name of milestones) {
          const reached = at(line, name, 0);
          if (reached !== undefined) deltas.get(name).push(reached - offer);
        }
      }
    }
  }
}
console.log(`receive connections with media: ${connections}`);
for (const [name, list] of deltas) {
  if (list.length) console.log(`${name.padEnd(20)} n=${String(list.length).padEnd(4)} p50=${quantile(list, 0.5)}ms p90=${quantile(list, 0.9)}ms max=${Math.max(...list)}ms`);
}
