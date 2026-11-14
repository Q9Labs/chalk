import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const AXIOM_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";
const HOST_CALLS = new Set(["StopInstances", "StartInstances", "RebootInstances"]);
// GitHub drops most scheduled runs of a frequent cron: the runs of this check were 5 to 8 hours apart in November 2026.
// Each run therefore looks back far enough to cover the longest gap seen, and Oncall dedupes on the incident key, so a repeat page is harmless.
const LOOKBACK_MS = 8 * 60 * 60 * 1000;
const CLOUDTRAIL_WINDOW_MS = LOOKBACK_MS;
const START_WINDOW_MS = LOOKBACK_MS;
// A deploy record is created before the API container restarts, so it explains a start from its creation until the deploy completes.
// A record that never completed (a failed attempt) has no end time and explains starts for this long.
const DEPLOY_LEAD_MS = 30 * 60 * 1000;
const DEPLOY_SLACK_MS = 120_000;
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
export function unexplainedStarts(starts, deployments) {
  const explains = (deployment, time) => time - deployment.created >= -DEPLOY_SLACK_MS && time <= (deployment.finished ? deployment.finished.getTime() + DEPLOY_SLACK_MS : deployment.created.getTime() + DEPLOY_LEAD_MS);
  return starts
    .filter((start) => !deployments.some((deployment) => explains(deployment, start.time)))
    .map((start) => ({
      key: `api-start:chalk:${start.time.toISOString()}`,
      detail: `The production API started at ${start.time.toISOString()} with no deploy record. Previous boot ended: ${start.previousBootEnd || "unknown"}. Every live socket dropped.`,
    }));
}

export function oncallPayload(incidents, { drill }) {
  return { source: "oncall-poller", ...(drill ? { drill: true } : {}), incidents: incidents.map((incident) => ({ app: "chalk", kind: "new", ...incident })) };
}

// The service says why it refused (a wrong dataset name, a bad window), and that text carries no secret.
async function bodyExcerpt(response) {
  return (await response.text().catch(() => "")).slice(0, 300);
}

async function readStarts({ fetchImpl, token, dataset, startTime, endTime }) {
  const response = await fetchImpl(AXIOM_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ apl: startsQuery(dataset), startTime, endTime }),
  }).catch(() => {
    throw new Error("Axiom query request failed");
  });
  if (!response.ok) throw new Error(`Axiom query answered HTTP ${response.status}: ${await bodyExcerpt(response)}`);
  return parseStarts(await response.json());
}

async function githubJson({ fetchImpl, token, path }) {
  const response = await fetchImpl(`https://api.github.com/repos/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  }).catch(() => {
    throw new Error("GitHub request failed");
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}: ${await bodyExcerpt(response)}`);
  return response.json();
}

/** Production release records that could explain a start in the window, with the time each one completed (null while open or failed). */
async function readDeployments({ fetchImpl, token, repository, since }) {
  const records = await githubJson({ fetchImpl, token, path: `${repository}/deployments?environment=production&task=production-release&per_page=50` });
  const recent = records.filter((record) => record.task === "production-release" && new Date(record.created_at) >= since);
  return Promise.all(
    recent.map(async (record) => {
      const statuses = await githubJson({ fetchImpl, token, path: `${repository}/deployments/${record.id}/statuses?per_page=10` });
      const success = statuses.find((status) => status.state === "success");
      return { created: new Date(record.created_at), finished: success ? new Date(success.created_at) : null };
    }),
  );
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
      readDeployments({ fetchImpl, token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY, since: new Date(now.getTime() - START_WINDOW_MS - DEPLOY_LEAD_MS) }),
    ]);
    incidents = [...hostCalls(calls, env.PRODUCTION_INSTANCE_ID), ...unexplainedStarts(starts, deployments)];
    log(`${incidents.length} incidents, ${starts.length} API starts, ${deployments.length} deploy records`);
  }
  if (!incidents.length) return 0;
  const response = await fetchImpl(env.ONCALL_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(oncallPayload(incidents, { drill })) }).catch(() => {
    throw new Error("Oncall webhook request failed");
  });
  if (!response.ok) throw new Error(`Oncall webhook answered HTTP ${response.status}: ${await bodyExcerpt(response)}`);
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
