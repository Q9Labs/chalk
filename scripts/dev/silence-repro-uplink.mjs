// Usage: node scripts/dev/silence-repro-uplink.mjs <uplink-probe.tsv> <output-dir>...
// Compares ICMP RTT (1.1.1.1 and the Cloudflare Realtime host) and the VM's upload rate during each run (originMs to the last sample) with the idle seconds between runs.
// Idle seconds: probe seconds that fall outside every run window of the listed directories and outside the 10 s after one.
import { readFileSync } from "node:fs";

const [probePath, ...dirs] = process.argv.slice(2);
const rows = readFileSync(probePath, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split(/\s+/))
  .map(([at, cloudflareDns, sfu, tx, rx]) => ({ at: Number(at), dns: cloudflareDns === "lost" ? null : Number(cloudflareDns), sfu: sfu === "lost" ? null : Number(sfu), tx: Number(tx), rx: Number(rx) }));
const windows = [];
for (const dir of dirs) {
  const result = JSON.parse(readFileSync(`${dir}/silence-repro.json`, "utf8"));
  for (const run of result.runs) {
    const last = Math.max(0, ...(run.samples ?? []).map((sample) => sample.atMs));
    windows.push({ name: `${dir.split("/").pop()}/${run.condition}`, start: run.originMs, end: run.originMs + last });
  }
}
const quantile = (values, q) => (values.length === 0 ? null : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]);
const stats = (values) => `n ${values.length} p50 ${quantile(values, 0.5)?.toFixed(0) ?? "-"} p95 ${quantile(values, 0.95)?.toFixed(0) ?? "-"} max ${values.length ? Math.max(...values).toFixed(0) : "-"}`;
const describe = (label, subset, withRates) => {
  const dns = subset.flatMap((row) => (row.dns === null ? [] : [row.dns]));
  const sfu = subset.flatMap((row) => (row.sfu === null ? [] : [row.sfu]));
  const lostDns = subset.filter((row) => row.dns === null).length;
  const lostSfu = subset.filter((row) => row.sfu === null).length;
  let line = `${label}: seconds ${subset.length}; 1.1.1.1 ms ${stats(dns)} lost ${lostDns}; SFU host ms ${stats(sfu)} lost ${lostSfu}`;
  if (withRates) {
    const up = [];
    const down = [];
    for (let i = 1; i < subset.length; i++) {
      const seconds = (subset[i].at - subset[i - 1].at) / 1000;
      if (seconds <= 0 || seconds > 3) continue;
      up.push(((subset[i].tx - subset[i - 1].tx) * 8) / seconds / 1e6);
      down.push(((subset[i].rx - subset[i - 1].rx) * 8) / seconds / 1e6);
    }
    const f = (values) => `p50 ${quantile(values, 0.5)?.toFixed(2)} p95 ${quantile(values, 0.95)?.toFixed(2)} max ${values.length ? Math.max(...values).toFixed(2) : "-"}`;
    line += `; upload Mbps ${f(up)}; download Mbps ${f(down)}`;
  }
  console.log(line);
};
const inWindow = (row, window, grace = 0) => row.at >= window.start && row.at <= window.end + grace;
const idle = rows.filter((row) => !windows.some((window) => inWindow(row, window, 10_000)) && !windows.some((window) => row.at >= window.start - 5_000 && row.at < window.start));
describe("idle", idle, true);
describe(
  "all runs",
  rows.filter((row) => windows.some((window) => inWindow(row, window))),
  true,
);
for (const window of windows)
  describe(
    window.name,
    rows.filter((row) => inWindow(row, window)),
    true,
  );
