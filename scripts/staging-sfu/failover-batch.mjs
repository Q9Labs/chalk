#!/usr/bin/env node
// Runs N failover trials against the STAGING own SFU and writes one JSON summary: recovered/N, audio-back p50 and p95, and the
// Cloudflare media request count over the batch window.
//
//   node scripts/staging-sfu/failover-batch.mjs --dry-run --trials 20 --out /tmp/failover-summary.json
//   scripts/staging-sfu/gate-lease <holder> failover-batch <run-id> -- \
//     node scripts/staging-sfu/failover-batch.mjs --trials 20 --modes stop,blackhole --out .private/failover/summary.json
//
// One trial: the fault starts on the staging node (mode "stop" stops chalk-sfu, mode "blackhole" drops its media and control
// ports), scripts/prod-proof/recovery.mjs watches two real SDK guests, then the node is restored and checked. A trial recovers
// when recovery.mjs exits 0 and audio comes back in both directions. Audio back is the later of the two directions, in seconds
// after the fault started.
//
// Addresses, keys and tokens never live in Git. A real run reads them from the environment (fill them from 1Password, for example
// `op run --env-file <private env file> -- ...`):
//   FAILOVER_NODE_HOST        ssh target of the staging primary node, such as root@<address>
//   FAILOVER_SSH_KEY          path to the operator key for that node
//   FAILOVER_KNOWN_HOSTS      path to the pinned known_hosts file for that node
//   FAILOVER_CLOUDFLARE_COUNT optional command that prints the number of Cloudflare media requests between $FAILOVER_SINCE and
//                             $FAILOVER_UNTIL (epoch seconds), for example a query on the staging API logs for
//                             cloudflare_sfu.call_trace. Without it the count is null and the batch can't pass.
//   plus what recovery.mjs needs for --environment staging (the proof.env values).
//
// --dry-run touches no node and no staging service: the fault and restore commands are `true`, and each trial reads a simulated
// recovery report instead of running recovery.mjs. It proves the batch loop, the parsing and the summary, nothing about recovery.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const TARGET = { recovered: 1, audioBackP95S: 10, cloudflareRequests: 0, minStopTrials: 5 };

const PORTS_DOWN = ["iptables -I INPUT 1 -p udp --dport 50000 -j DROP", "iptables -I INPUT 1 -p tcp --dport 50000 -j DROP", "iptables -I INPUT 1 -p tcp --dport 8443 -j DROP"];
const PORTS_UP = PORTS_DOWN.map((rule) => rule.replace("-I INPUT 1", "-D INPUT"));
const UNIT = "systemctl --user -M chalk-sfu@";
const NODE_COMMANDS = {
  stop: { fault: `${UNIT} stop chalk-sfu`, restore: `${UNIT} start chalk-sfu` },
  blackhole: { fault: PORTS_DOWN.join("; "), restore: PORTS_UP.join("; ") },
  check: `iptables -S INPUT | grep -c 'dport 50000 -j DROP'; ${UNIT} is-active chalk-sfu`,
};

export function percentile(values, p) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo)) * 10) / 10;
}

// recovery.mjs prints its report as JSON, then a "Private evidence: <dir>" line.
export function parseRecoveryOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("Private evidence");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start, end < 0 ? undefined : end));
  } catch {
    return null;
  }
}

export function trialResult({ name, mode, exitCode, report }) {
  const audio = (side) => report?.[side]?.audio ?? null;
  const down = audio("down");
  const up = audio("up");
  const backOf = (a) => (a && !a.never_back && typeof a.back_after_fault_start_s === "number" ? a.back_after_fault_start_s : null);
  const backs = [backOf(down), backOf(up)];
  const recovered = exitCode === 0 && backs.every((b) => b !== null);
  return { name, mode, exitCode, recovered, audioBackS: recovered ? Math.max(...backs) : null, audioDownS: backs[0], audioUpS: backs[1] };
}

export function summarize({ trials, cloudflareRequests, dryRun, startedAt, endedAt }) {
  const recovered = trials.filter((t) => t.recovered).length;
  const backs = trials.map((t) => t.audioBackS).filter((v) => v !== null);
  const p95 = percentile(backs, 0.95);
  const stopTrials = trials.filter((t) => t.mode === "stop").length;
  const checks = {
    allRecovered: trials.length > 0 && recovered === trials.length,
    audioBackP95Under10s: p95 !== null && p95 < TARGET.audioBackP95S,
    zeroCloudflareRequests: cloudflareRequests === TARGET.cloudflareRequests,
    enoughStopTrials: stopTrials >= TARGET.minStopTrials,
  };
  return {
    environment: "staging",
    dryRun,
    startedAt,
    endedAt,
    trials: trials.length,
    recovered,
    recoveredOfN: `${recovered}/${trials.length}`,
    audioBackS: { n: backs.length, p50: percentile(backs, 0.5), p95, max: backs.length ? Math.max(...backs) : null },
    cloudflareRequests,
    target: TARGET,
    checks,
    pass: !dryRun && Object.values(checks).every(Boolean),
    perTrial: trials,
  };
}

// Deterministic stand-in for one recovery.mjs report, so a dry run exercises the same parsing path as a real one.
function simulatedRecoveryOutput(index) {
  const back = 4 + ((index * 7) % 50) / 10;
  const side = (s) => ({ audio: { interrupted: true, back_after_fault_start_s: s, never_back: false } });
  return `${JSON.stringify({ scenario: "dry-run", down: side(back), up: side(back - 0.5) }, null, 1)}\nPrivate evidence: (dry run)\n`;
}

function sh(command, env = process.env) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8", env, timeout: 420_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function nodeSsh() {
  const { FAILOVER_NODE_HOST: host, FAILOVER_SSH_KEY: key, FAILOVER_KNOWN_HOSTS: knownHosts } = process.env;
  const missing = Object.entries({ FAILOVER_NODE_HOST: host, FAILOVER_SSH_KEY: key, FAILOVER_KNOWN_HOSTS: knownHosts })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`a real run needs ${missing.join(", ")} (read them from 1Password at run time)`);
  const control = `${process.env.TMPDIR ?? "/tmp"}/failover-batch-cm-%r@%h`;
  return `ssh -i '${key}' -o UserKnownHostsFile='${knownHosts}' -o StrictHostKeyChecking=yes -o BatchMode=yes -o ControlMaster=auto -o ControlPath='${control}' -o ControlPersist=600 ${host}`;
}

function runTrial({ index, mode, dryRun, ssh, watchS, settleS, log }) {
  const name = `${mode}-${index + 1}`;
  const commands = NODE_COMMANDS[mode];
  log(`== trial ${name} ${new Date().toISOString()}`);
  if (dryRun) {
    const report = parseRecoveryOutput(simulatedRecoveryOutput(index));
    return trialResult({ name, mode, exitCode: sh("true").code, report });
  }
  const startCmd = `${ssh} ${JSON.stringify(commands.fault)}`;
  const recovery = resolve(dirname(new URL(import.meta.url).pathname), "../prod-proof/recovery.mjs");
  const run = spawnSync("node", [recovery, "--environment", "staging", "--scenario", `failover-${mode}`, "--start-cmd", startCmd, "--watch-s", String(watchS), "--settle-s", String(settleS)], { encoding: "utf8", timeout: 400_000 });
  const restore = sh(`${ssh} ${JSON.stringify(commands.restore)}; ${ssh} ${JSON.stringify(NODE_COMMANDS.check)}`);
  log(`   rc=${run.status} restore: ${restore.out.trim().replace(/\n/g, " ")}`);
  return trialResult({ name, mode, exitCode: run.status ?? 1, report: parseRecoveryOutput(`${run.stdout ?? ""}`) });
}

function countCloudflare({ dryRun, since, until }) {
  if (dryRun) return 0;
  const command = process.env.FAILOVER_CLOUDFLARE_COUNT;
  if (!command) return null;
  const r = sh(command, { ...process.env, FAILOVER_SINCE: String(since), FAILOVER_UNTIL: String(until) });
  const n = Number.parseInt(r.out.trim().split("\n").pop() ?? "", 10);
  return r.code === 0 && Number.isFinite(n) ? n : null;
}

export function planModes(modes, trials) {
  return Array.from({ length: trials }, (_, i) => modes[i % modes.length]);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      trials: { type: "string", default: "20" },
      modes: { type: "string", default: "stop,blackhole" },
      out: { type: "string", default: ".private/failover/summary.json" },
      "watch-s": { type: "string", default: "60" },
      "settle-s": { type: "string", default: "15" },
      "gap-s": { type: "string", default: "20" },
    },
  });
  const dryRun = values["dry-run"];
  const trials = Number.parseInt(values.trials, 10);
  const modes = values.modes.split(",").map((m) => m.trim());
  const unknown = modes.filter((m) => !NODE_COMMANDS[m] || m === "check");
  if (!Number.isInteger(trials) || trials < 1) throw new Error(`--trials must be a positive integer, got ${values.trials}`);
  if (unknown.length) throw new Error(`unknown mode ${unknown.join(", ")}; use stop or blackhole`);
  const ssh = dryRun ? "true" : nodeSsh();
  const log = (line) => process.stderr.write(`${line}\n`);
  const startedAt = new Date().toISOString();
  const since = Math.floor(Date.now() / 1000);
  const results = [];
  for (const [index, mode] of planModes(modes, trials).entries()) {
    results.push(runTrial({ index, mode, dryRun, ssh, watchS: values["watch-s"], settleS: values["settle-s"], log }));
    if (!dryRun && index < trials - 1) sh(`sleep ${Number.parseInt(values["gap-s"], 10)}`);
  }
  const until = Math.floor(Date.now() / 1000);
  const summary = summarize({ trials: results, cloudflareRequests: countCloudflare({ dryRun, since, until }), dryRun, startedAt, endedAt: new Date().toISOString() });
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(summary, null, 1)}\n`);
  const { perTrial, ...head } = summary;
  console.log(JSON.stringify(head, null, 1));
  log(`summary: ${resolve(values.out)}`);
  process.exitCode = summary.pass || dryRun ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`failover-batch: ${error.message}`);
    process.exit(2);
  });
}
