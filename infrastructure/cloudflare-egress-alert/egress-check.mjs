// Reads Realtime SFU and TURN egress from Cloudflare GraphQL analytics and posts
// to the Oncall webhook when a limit is crossed. Cloudflare's own usage alert
// cannot watch these products, and they share one monthly free allowance.

const GB = 1e9;
export const DAILY_LIMIT_GB = 100;
export const MONTHLY_THRESHOLDS_GB = [500, 800];

// Oncall's poller registers the same keys for Chalk (scope:app:id). A key that is not
// on this list is not a check Oncall can confirm.
const key = (id) => `cloudflare-sfu-turn-egress:chalk:${id}`;
export const ALERT_KEYS = [key("24h"), ...MONTHLY_THRESHOLDS_GB.map((gb) => key(`month-${gb}gb`))];

// A monthly threshold alerts on every run until its crossing is this old, so one or two
// missed or failed runs cannot hide it. Oncall dedupes the repeats by key.
const LOOKBACK_HOURS = 72;

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const QUERY = `query ($account: String!, $dayStart: Time!, $monthStart: Time!, $priorEnd: Time!, $now: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      daySfu: callsUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $dayStart, datetime_lt: $now }) { sum { egressBytes } }
      dayTurn: callsTurnUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $dayStart, datetime_lt: $now }) { sum { egressBytes } }
      monthSfu: callsUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $monthStart, datetime_lt: $now }) { sum { egressBytes } }
      monthTurn: callsTurnUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $monthStart, datetime_lt: $now }) { sum { egressBytes } }
      priorSfu: callsUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $monthStart, datetime_lt: $priorEnd }) { sum { egressBytes } }
      priorTurn: callsTurnUsageAdaptiveGroups(limit: 1, filter: { datetime_geq: $monthStart, datetime_lt: $priorEnd }) { sum { egressBytes } }
    }
  }
}`;

function groupBytes(groups) {
  return groups[0]?.sum.egressBytes ?? 0;
}

export async function readEgress({ fetchImpl = fetch, accountId, token, now }) {
  const dayStart = new Date(now.getTime() - 24 * 3600 * 1000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const priorEnd = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  const response = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        account: accountId,
        dayStart: dayStart.toISOString(),
        monthStart: monthStart.toISOString(),
        priorEnd: priorEnd.toISOString(),
        now: now.toISOString(),
      },
    }),
  });
  if (!response.ok) throw new Error(`Cloudflare GraphQL answered HTTP ${response.status}`);
  const body = await response.json();
  const account = body.data?.viewer.accounts[0];
  if (body.errors || !account) throw new Error(`Cloudflare GraphQL returned no usage: ${JSON.stringify(body.errors)}`);
  return {
    dayBytes: groupBytes(account.daySfu) + groupBytes(account.dayTurn),
    monthBytes: groupBytes(account.monthSfu) + groupBytes(account.monthTurn),
    // Month-to-date total as of the lookback. It is empty, so 0, while the lookback still falls in last month.
    priorBytes: groupBytes(account.priorSfu) + groupBytes(account.priorTurn),
  };
}

const gb = (bytes) => Math.round(bytes / GB);

// A monthly threshold is open while the month total is past it and the total
// LOOKBACK_HOURS ago was not. That needs no state from the run before.
export function evaluate({ dayBytes, monthBytes, priorBytes }) {
  const incidents = [];
  if (dayBytes >= DAILY_LIMIT_GB * GB) {
    incidents.push({
      key: key("24h"),
      detail: `Realtime SFU and TURN sent ${gb(dayBytes)} GB in the last 24 h (limit ${DAILY_LIMIT_GB} GB).`,
    });
  }
  for (const threshold of MONTHLY_THRESHOLDS_GB) {
    if (monthBytes >= threshold * GB && priorBytes < threshold * GB) {
      incidents.push({
        key: key(`month-${threshold}gb`),
        detail: `Realtime SFU and TURN sent ${gb(monthBytes)} GB this month, past ${threshold} GB of the 1,000 GB free allowance.`,
      });
    }
  }
  return incidents;
}

export function oncallPayload(incidents, { drill }) {
  return {
    source: "oncall-poller",
    ...(drill ? { drill: true } : {}),
    incidents: incidents.map((incident) => ({ app: "chalk", kind: "new", ...incident })),
  };
}

export async function run({ env, fetchImpl = fetch, now = new Date(), log = console.log }) {
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_TOKEN, ONCALL_WEBHOOK_URL, EGRESS_CHECK_DRILL } = env;
  // A drill tests the Oncall webhook alone, so it never reads Cloudflare.
  const drill = EGRESS_CHECK_DRILL === "true";
  if (!ONCALL_WEBHOOK_URL || (!drill && (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_ANALYTICS_TOKEN))) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_TOKEN and ONCALL_WEBHOOK_URL are required");
  }
  let incidents = [{ key: key("24h"), detail: "Drill: test notification from the Cloudflare egress check. No usage limit was crossed." }];
  if (!drill) {
    const usage = await readEgress({ fetchImpl, accountId: CLOUDFLARE_ACCOUNT_ID, token: CLOUDFLARE_ANALYTICS_TOKEN, now });
    log(`SFU+TURN egress: ${gb(usage.dayBytes)} GB in 24 h, ${gb(usage.monthBytes)} GB this month`);
    incidents = evaluate(usage);
  }
  if (incidents.length === 0) return 0;

  for (const incident of incidents) log(incident.detail);
  const response = await fetchImpl(ONCALL_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(oncallPayload(incidents, { drill })),
  });
  if (!response.ok) throw new Error(`Oncall webhook answered HTTP ${response.status}`);
  // A crossed limit fails the run on purpose so GitHub also emails the failure.
  return drill ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run({ env: process.env });
}
