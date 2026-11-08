// Dataset names are deployment configuration, not public repository constants.
const datasets = (env = process.env) => ({ api: env.CHALK_AXIOM_STAGING_LOG_DATASET });
const literal = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const rowLimit = 1000;

function query(dataset) {
  return `[${literal(dataset)}]
| where ['service.name'] == 'chalk-api' and ['attributes.provider'] == 'chalk_sfu'
| project episode_id=tostring(['attributes.episode_id']), session_id=tostring(['attributes.provider_session_id'])
| limit ${rowLimit}`;
}

export async function readLogs(startTime, endTime, { env = process.env, fetchImpl = fetch } = {}) {
  const { api } = datasets(env);
  if (!api || !env.CHALK_AXIOM_QUERY_TOKEN) throw new Error("staging_log_configuration_missing");
  const response = await fetchImpl("https://api.axiom.co/v1/datasets/_apl?format=tabular", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CHALK_AXIOM_QUERY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ apl: query(api), startTime, endTime, limit: rowLimit }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`staging_log_query_http_${response.status}`);
  const body = await response.json();
  const table = body?.tables?.[0];
  if (body?.status?.isPartial || body?.status?.isEstimate || body?.status?.messages?.some((m) => m.priority === "error") || body?.tables?.length !== 1) throw new Error("staging_log_query_incomplete");
  const names = table?.fields?.map((field) => field.name);
  if (names?.length !== 2 || !names.includes("episode_id") || !names.includes("session_id") || table.columns?.length !== 2 || !table.columns.every((column) => Array.isArray(column) && column.length === table.columns[0].length)) throw new Error("staging_log_query_malformed");
  const rows = table.columns[0].length;
  // A full page cannot prove isolation, even if Axiom supplies no pagination metadata.
  if (rows >= rowLimit || body.continuationToken || body.status?.continuationToken || body.status?.rowsMatched > rows) throw new Error("staging_log_query_incomplete");
  return table.columns[0].map((_, i) => {
    const row = Object.fromEntries(names.map((name, j) => [name, table.columns[j][i]]));
    if (typeof row.episode_id !== "string" || typeof row.session_id !== "string") throw new Error("staging_log_query_malformed");
    return row;
  });
}
