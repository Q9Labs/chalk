import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const AXIOM_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";
const HOST_CALLS = new Set(["StopInstances", "StartInstances", "RebootInstances"]);
const CLOUDTRAIL_WINDOW_MS = 30 * 60 * 1000;
const START_WINDOW_MS = 10 * 60 * 1000;
// A deploy record may be created a few minutes before the API container restarts, so it explains a start for this long.
const DEPLOY_LEAD_MS = 30 * 60 * 1000;
const literal = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export function startsQuery(dataset) {
  return `[${literal(dataset)}]
| where ['service.name'] == 'chalk-api' and ['attributes.event'] == 'api.starting'
| project _time, previous_boot_end=tostring(['attributes.previous_boot_end'])`;
}

export function parseStarts(body) {
  const table = body?.tables?.[0];
  if (!Array.isArray(table?.fields) || !Array.isArray(table?.columns) || body.status?.isPartial) throw new Error("Axiom returned a malformed tabular response");
  const names = table.fields.map((field) => field?.name);
  const time = names.indexOf("_time");
  const boot = names.indexOf("previous_boot_end");
  if (time < 0) throw new Error("Axiom returned a malformed tabular response");
  return table.columns[time].map((value, i) => ({ time: new Date(value), previousBootEnd: boot < 0 ? "" : table.columns[boot][i] }));
}

/** CloudTrail events that stop, start or reboot the production node. */
export function hostCalls(events, instanceId) {
  return events
    .filter((event) => HOST_CALLS.has(event.EventName) && event.Resources?.some((r) => r.ResourceName === instanceId))
    .map((event) => ({
      key: `host-change:chalk:${event.EventId}`,
      detail: `${event.EventName} was called on the production node at ${new Date(event.EventTime).toISOString()} by ${event.Username ?? "an unknown caller"}. Nobody stops or reboots it by hand: use the deploy or rollback path.`,
    }));
}

/** API starts that no deploy record explains: a crash, a host restart or a hand-run command. */
export function unexplainedStarts(starts, deploymentTimes) {
  return starts
    .filter((start) => !deploymentTimes.some((deployed) => start.time - deployed >= -120_000 && start.time - deployed <= DEPLOY_LEAD_MS))
    .map((start) => ({
      key: `api-start:chalk:${start.time.toISOString()}`,
      detail: `The production API started at ${start.time.toISOString()} with no deploy record. Previous boot ended: ${start.previousBootEnd || "unknown"}. Every live socket dropped.`,
    }));
}

export function oncallPayload(incidents, { drill }) {
  return { source: "oncall-poller", ...(drill ? { drill: true } : {}), incidents: incidents.map((incident) => ({ app: "chalk", kind: "new", ...incident })) };
}

async function readStarts({ fetchImpl, token, dataset, startTime, endTime }) {
  const response = await fetchImpl(AXIOM_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ apl: startsQuery(dataset), startTime, endTime }),
  }).catch(() => {
    throw new Error("Axiom query request failed");
  });
  if (!response.ok) throw new Error(`Axiom query answered HTTP ${response.status}`);
  return parseStarts(await response.json());
}

async function readDeployments({ fetchImpl, token, repository }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/deployments?environment=production&per_page=50`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  }).catch(() => {
    throw new Error("GitHub deployments request failed");
  });
  if (!response.ok) throw new Error(`GitHub deployments answered HTTP ${response.status}`);
  return (await response.json()).map((deployment) => new Date(deployment.created_at));
}

// One lookup per event name: a lookup by resource returns the newest 50 events of any kind, which API reads can fill.
async function readHostCalls({ now, awsImpl }) {
  const start = new Date(now.getTime() - CLOUDTRAIL_WINDOW_MS).toISOString();
  const lookups = [...HOST_CALLS].map(async (name) => {
    const output = await awsImpl(["cloudtrail", "lookup-events", "--lookup-attributes", `AttributeKey=EventName,AttributeValue=${name}`, "--start-time", start, "--end-time", now.toISOString(), "--max-results", "50", "--output", "json"]);
    return JSON.parse(output).Events;
  });
  return (await Promise.all(lookups)).flat().map((event) => ({ EventId: event.EventId, EventName: event.EventName, EventTime: event.EventTime, Username: event.Username, Resources: event.Resources }));
}

const aws = async (args) => (await run("aws", args)).stdout;

export async function check({ env, fetchImpl = fetch, awsImpl = aws, now = new Date(), log = console.log }) {
  const drill = env.HOST_CHANGE_CHECK_DRILL === "true";
  const required = ["ONCALL_WEBHOOK_URL", ...(!drill ? ["CHALK_AXIOM_QUERY_TOKEN", "CHALK_AXIOM_LOG_DATASET", "PRODUCTION_INSTANCE_ID", "GITHUB_TOKEN", "GITHUB_REPOSITORY"] : [])];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  let incidents = [{ key: "host-change:chalk:drill", detail: "Drill: test notification from the host change check. Nothing happened to the production node." }];
  if (!drill) {
    const startTime = new Date(now.getTime() - START_WINDOW_MS).toISOString();
    const [calls, starts, deployments] = await Promise.all([
      readHostCalls({ now, awsImpl }),
      readStarts({ fetchImpl, token: env.CHALK_AXIOM_QUERY_TOKEN, dataset: env.CHALK_AXIOM_LOG_DATASET, startTime, endTime: now.toISOString() }),
      readDeployments({ fetchImpl, token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY }),
    ]);
    incidents = [...hostCalls(calls, env.PRODUCTION_INSTANCE_ID), ...unexplainedStarts(starts, deployments)];
    log(`${incidents.length} incidents, ${starts.length} API starts, ${deployments.length} deploy records`);
  }
  if (!incidents.length) return 0;
  const response = await fetchImpl(env.ONCALL_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(oncallPayload(incidents, { drill })) }).catch(() => {
    throw new Error("Oncall webhook request failed");
  });
  if (!response.ok) throw new Error(`Oncall webhook answered HTTP ${response.status}`);
  // A fired alert fails the run so GitHub also emails the failure.
  return drill ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await check({ env: process.env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
