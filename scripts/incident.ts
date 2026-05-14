const DEFAULT_API_URL = "http://localhost:8080";
const INCIDENTS_ROOT = "/api/v1/admin/ops";

function usage(): string {
  return `
Chalk incident CLI

Usage:
  pnpm exec tsx scripts/incident.ts <command> [options]

Global options:
  --api-url <url>          API base URL (default: CHALK_API_URL or http://localhost:8080)
  --admin-secret <secret>  Admin secret (default: CHALK_ADMIN_SECRET)
  --json                   Machine-readable output
  --help                   Show this help

Commands:
  declare                  Declare a new incident
  note <incidentCode>      Add an event/note to an incident
  publish <incidentCode>   Publish incident to public status
  resolve <incidentCode>   Resolve an incident
  list                     List incidents
  show <incidentCode>      Show one incident with events
  signals                  Show signals from ops overview
  maintenance schedule     Schedule maintenance
  maintenance cancel <id>  Cancel maintenance window
  ai-summary <incidentCode> Generate AI drafts for incident summary updates

Examples:
  pnpm exec tsx scripts/incident.ts declare --title "API outage" --severity critical --components api,web
  pnpm exec tsx scripts/incident.ts note INC-20260414-01 --message "Mitigation applied" --event-type update
  pnpm exec tsx scripts/incident.ts publish INC-20260414-01 --public-message "We are investigating elevated errors"
  pnpm exec tsx scripts/incident.ts list --limit 25 --offset 0
  pnpm exec tsx scripts/incident.ts maintenance schedule --title "DB patching" --starts-at 2026-04-15T02:00:00Z --ends-at 2026-04-15T03:00:00Z --components api
  pnpm exec tsx scripts/incident.ts maintenance cancel 3fa85f64-5717-4562-b3fc-2c963f66afa6
`.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    if (trimmed.length === 0) {
      throw new Error("Invalid flag: --");
    }

    const eq = trimmed.indexOf("=");
    if (eq >= 0) {
      const key = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      const existing = flags.get(key) ?? [];
      existing.push(value);
      flags.set(key, existing);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      const existing = flags.get(trimmed) ?? [];
      existing.push(next);
      flags.set(trimmed, existing);
      i += 1;
      continue;
    }

    const existing = flags.get(trimmed) ?? [];
    existing.push("true");
    flags.set(trimmed, existing);
  }

  return { positionals, flags };
}

function hasFlag(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}

function flagValue(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  return values?.[values.length - 1];
}

function allFlagValues(flags: Map<string, string[]>, names: string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const entries = flags.get(name) ?? [];
    values.push(...entries);
  }
  return values;
}

function requireFlag(flags: Map<string, string[]>, name: string, helpText?: string): string {
  const value = flagValue(flags, name)?.trim();
  if (value) {
    return value;
  }
  throw new Error(helpText ?? `Missing required flag --${name}`);
}

function parseIntegerFlag(flags: Map<string, string[]>, name: string, fallback: number): number {
  const value = flagValue(flags, name);
  if (value === undefined) {
    return fallback;
  }
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return numeric;
}

function parseJsonFlag(flags: Map<string, string[]>, name: string): unknown {
  const raw = flagValue(flags, name);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON for --${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseIsoFlag(flags: Map<string, string[]>, name: string): string | undefined {
  const raw = flagValue(flags, name);
  if (!raw) {
    return undefined;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`--${name} must be a valid datetime`);
  }
  return date.toISOString();
}

function requireIsoFlag(flags: Map<string, string[]>, name: string): string {
  const value = parseIsoFlag(flags, name);
  if (!value) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function parseComponents(flags: Map<string, string[]>): string[] {
  const raw = allFlagValues(flags, ["components", "component"]);
  const components = raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(components));
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries);
}

function extractErrorMessage(data: unknown): string {
  if (isRecord(data)) {
    const message = data.message ?? data.error ?? data.detail;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  if (typeof data === "string" && data.trim().length > 0) {
    return data.trim();
  }
  return "Request failed";
}

function extractActor(flags: Map<string, string[]>): Record<string, unknown> | undefined {
  const actorKind = trimOrUndefined(flagValue(flags, "actor-kind"));
  const actorId = trimOrUndefined(flagValue(flags, "actor-id"));
  if (!actorKind && !actorId) {
    return undefined;
  }
  return compactObject({
    kind: actorKind ?? "human",
    id: actorId ?? "cli",
  });
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function requestApi(
  apiUrl: string,
  adminSecret: string,
  method: string,
  path: string,
  options?: { query?: Record<string, string | number | undefined>; body?: unknown },
) {
  const url = new URL(path, normalizeBaseUrl(apiUrl));
  const params = new URLSearchParams();
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
  }
  if (Array.from(params.keys()).length > 0) {
    url.search = params.toString();
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    "x-admin-secret": adminSecret,
  };
  if (options?.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let data: unknown = null;
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = extractErrorMessage(data);
    const error = new Error(`${response.status} ${response.statusText}: ${message}`) as Error & {
      status?: number;
      data?: unknown;
    };
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return { status: response.status, data };
}

function toObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printIncidentList(data: unknown): void {
  const incidents = Array.isArray(data) ? toObjectArray(data) : isRecord(data) ? toObjectArray(data.incidents) : [];
  if (incidents.length === 0) {
    console.log("No incidents found.");
    return;
  }
  for (const incident of incidents) {
    const code = typeof incident.incident_code === "string" ? incident.incident_code : "(no-code)";
    const status = typeof incident.status === "string" ? incident.status : "unknown";
    const severity = typeof incident.severity === "string" ? incident.severity : "unknown";
    const title = typeof incident.title === "string" ? incident.title : "(untitled)";
    console.log(`${code} | ${status} | ${severity} | ${title}`);
  }
}

function printIncidentDetails(data: unknown): void {
  if (!isRecord(data) || !isRecord(data.incident)) {
    printJson(data);
    return;
  }
  const incident = data.incident;
  const code = typeof incident.incident_code === "string" ? incident.incident_code : "(no-code)";
  const title = typeof incident.title === "string" ? incident.title : "(untitled)";
  const status = typeof incident.status === "string" ? incident.status : "unknown";
  const severity = typeof incident.severity === "string" ? incident.severity : "unknown";
  const visibility = typeof incident.visibility === "string" ? incident.visibility : "unknown";
  console.log(`${code} - ${title}`);
  console.log(`status=${status} severity=${severity} visibility=${visibility}`);

  const events = toObjectArray(data.events);
  if (events.length === 0) {
    return;
  }
  console.log("events:");
  for (const event of events) {
    const at = typeof event.event_at === "string" ? event.event_at : "unknown-time";
    const eventType = typeof event.event_type === "string" ? event.event_type : "event";
    const eventVisibility = typeof event.visibility === "string" ? event.visibility : "unknown";
    const message = typeof event.message === "string" ? event.message : "";
    console.log(`- ${at} [${eventType}/${eventVisibility}] ${message}`.trim());
  }
}

function printSignals(data: unknown): void {
  if (!isRecord(data)) {
    printJson(data);
    return;
  }
  const signals = isRecord(data.signals) ? data.signals : data;
  const monitors = toObjectArray(signals.monitors);
  const heartbeats = toObjectArray(signals.heartbeats);
  console.log(`monitors=${monitors.length} heartbeats=${heartbeats.length}`);
  for (const monitor of monitors) {
    const key = typeof monitor.monitor_key === "string" ? monitor.monitor_key : "(monitor)";
    const status = typeof monitor.status === "string" ? monitor.status : "unknown";
    console.log(`monitor ${key} -> ${status}`);
  }
  for (const heartbeat of heartbeats) {
    const key = typeof heartbeat.heartbeat_key === "string" ? heartbeat.heartbeat_key : "(heartbeat)";
    const status = typeof heartbeat.status === "string" ? heartbeat.status : "unknown";
    console.log(`heartbeat ${key} -> ${status}`);
  }
}

function printMaintenance(data: unknown): void {
  if (!isRecord(data)) {
    printJson(data);
    return;
  }
  const id = typeof data.id === "string" ? data.id : "(no-id)";
  const title = typeof data.title === "string" ? data.title : "(untitled)";
  const status = typeof data.status === "string" ? data.status : "unknown";
  console.log(`${id} | ${status} | ${title}`);
}

function printAiSummary(data: unknown): void {
  if (!isRecord(data)) {
    printJson(data);
    return;
  }
  const internalSummary = typeof data.internal_summary === "string" ? data.internal_summary : undefined;
  const publicUpdate = typeof data.public_update === "string" ? data.public_update : undefined;
  const resolutionNote = typeof data.resolution_note === "string" ? data.resolution_note : undefined;
  if (!internalSummary && !publicUpdate && !resolutionNote) {
    printJson(data);
    return;
  }
  console.log("internal_summary:");
  console.log(internalSummary ?? "");
  console.log("");
  console.log("public_update:");
  console.log(publicUpdate ?? "");
  console.log("");
  console.log("resolution_note:");
  console.log(resolutionNote ?? "");
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const wantsHelp = hasFlag(flags, "help");
  if (positionals.length === 0 || wantsHelp) {
    console.log(usage());
    return;
  }

  const command = positionals[0];
  if (command === "help") {
    console.log(usage());
    return;
  }

  const jsonOutput = hasFlag(flags, "json");
  const apiUrl = trimOrUndefined(flagValue(flags, "api-url")) ?? process.env.CHALK_API_URL ?? DEFAULT_API_URL;
  const adminSecret = trimOrUndefined(flagValue(flags, "admin-secret")) ?? process.env.CHALK_ADMIN_SECRET ?? "";

  if (!adminSecret) {
    throw new Error("Missing admin secret. Set CHALK_ADMIN_SECRET or pass --admin-secret.");
  }

  let label = command;
  let result: { status: number; data: unknown };

  if (command === "declare") {
    const body = compactObject({
      incident_code: trimOrUndefined(flagValue(flags, "incident-code")),
      title: requireFlag(flags, "title"),
      summary: trimOrUndefined(flagValue(flags, "summary")),
      severity: trimOrUndefined(flagValue(flags, "severity")) ?? "major",
      status: trimOrUndefined(flagValue(flags, "status")),
      visibility: trimOrUndefined(flagValue(flags, "visibility")),
      source_kind: trimOrUndefined(flagValue(flags, "source-kind")) ?? "manual",
      source_key: trimOrUndefined(flagValue(flags, "source-key")),
      component_ids: parseComponents(flags),
      dedupe_key: trimOrUndefined(flagValue(flags, "dedupe-key")),
      idempotency_key: trimOrUndefined(flagValue(flags, "idempotency-key")),
      public_message: trimOrUndefined(flagValue(flags, "public-message")),
      public_title: trimOrUndefined(flagValue(flags, "public-title")),
      metadata: parseJsonFlag(flags, "metadata"),
      occurred_at: parseIsoFlag(flags, "occurred-at"),
      event_message: trimOrUndefined(flagValue(flags, "event-message")),
      actor: extractActor(flags),
    });
    result = await requestApi(apiUrl, adminSecret, "POST", `${INCIDENTS_ROOT}/incidents/declare`, { body });
  } else if (command === "note") {
    const incidentCode = positionals[1];
    if (!incidentCode) {
      throw new Error("Usage: note <incidentCode> --message <text>");
    }
    const body = compactObject({
      event_type: trimOrUndefined(flagValue(flags, "event-type")) ?? "note",
      visibility: trimOrUndefined(flagValue(flags, "visibility")) ?? "internal",
      message: requireFlag(flags, "message"),
      metadata: parseJsonFlag(flags, "metadata"),
      idempotency_key: trimOrUndefined(flagValue(flags, "idempotency-key")),
      event_at: parseIsoFlag(flags, "event-at"),
      transition_to: trimOrUndefined(flagValue(flags, "transition-to")),
      public_message: trimOrUndefined(flagValue(flags, "public-message")),
      public_title: trimOrUndefined(flagValue(flags, "public-title")),
      updated_summary: trimOrUndefined(flagValue(flags, "summary")),
      actor: extractActor(flags),
    });
    result = await requestApi(
      apiUrl,
      adminSecret,
      "POST",
      `${INCIDENTS_ROOT}/incidents/${encodeURIComponent(incidentCode)}/events`,
      { body },
    );
  } else if (command === "publish") {
    const incidentCode = positionals[1];
    if (!incidentCode) {
      throw new Error("Usage: publish <incidentCode> [--message ...] [--public-message ...]");
    }
    const body = compactObject({
      message: trimOrUndefined(flagValue(flags, "message")),
      public_message: trimOrUndefined(flagValue(flags, "public-message")),
      public_title: trimOrUndefined(flagValue(flags, "public-title")),
      event_at: parseIsoFlag(flags, "event-at"),
      actor: extractActor(flags),
    });
    result = await requestApi(
      apiUrl,
      adminSecret,
      "POST",
      `${INCIDENTS_ROOT}/incidents/${encodeURIComponent(incidentCode)}/publish`,
      { body },
    );
  } else if (command === "resolve") {
    const incidentCode = positionals[1];
    if (!incidentCode) {
      throw new Error("Usage: resolve <incidentCode> [--message ...] [--summary ...]");
    }
    const body = compactObject({
      message: trimOrUndefined(flagValue(flags, "message")),
      summary: trimOrUndefined(flagValue(flags, "summary")),
      event_at: parseIsoFlag(flags, "event-at"),
      actor: extractActor(flags),
    });
    result = await requestApi(
      apiUrl,
      adminSecret,
      "POST",
      `${INCIDENTS_ROOT}/incidents/${encodeURIComponent(incidentCode)}/resolve`,
      { body },
    );
  } else if (command === "list") {
    const limit = parseIntegerFlag(flags, "limit", 20);
    const offset = parseIntegerFlag(flags, "offset", 0);
    result = await requestApi(apiUrl, adminSecret, "GET", `${INCIDENTS_ROOT}/incidents`, {
      query: { limit, offset },
    });
  } else if (command === "show") {
    const incidentCode = positionals[1];
    if (!incidentCode) {
      throw new Error("Usage: show <incidentCode>");
    }
    result = await requestApi(apiUrl, adminSecret, "GET", `${INCIDENTS_ROOT}/incidents/${encodeURIComponent(incidentCode)}`);
  } else if (command === "signals") {
    result = await requestApi(apiUrl, adminSecret, "GET", `${INCIDENTS_ROOT}/overview`);
  } else if (command === "maintenance") {
    const subcommand = positionals[1];
    if (subcommand === "schedule") {
      label = "maintenance schedule";
      const body = compactObject({
        title: requireFlag(flags, "title"),
        summary: trimOrUndefined(flagValue(flags, "summary")),
        component_ids: parseComponents(flags),
        starts_at: requireIsoFlag(flags, "starts-at"),
        ends_at: requireIsoFlag(flags, "ends-at"),
        public_message: trimOrUndefined(flagValue(flags, "public-message")),
        actor: extractActor(flags),
      });
      result = await requestApi(apiUrl, adminSecret, "POST", `${INCIDENTS_ROOT}/maintenance`, { body });
    } else if (subcommand === "cancel") {
      label = "maintenance cancel";
      const maintenanceId = positionals[2];
      if (!maintenanceId) {
        throw new Error("Usage: maintenance cancel <maintenanceId>");
      }
      result = await requestApi(
        apiUrl,
        adminSecret,
        "POST",
        `${INCIDENTS_ROOT}/maintenance/${encodeURIComponent(maintenanceId)}/cancel`,
      );
    } else {
      throw new Error("Usage: maintenance <schedule|cancel>");
    }
  } else if (command === "ai-summary") {
    const incidentCode = positionals[1];
    if (!incidentCode) {
      throw new Error("Usage: ai-summary <incidentCode>");
    }
    result = await requestApi(
      apiUrl,
      adminSecret,
      "POST",
      `${INCIDENTS_ROOT}/incidents/${encodeURIComponent(incidentCode)}/ai-drafts`,
    );
  } else {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }

  if (jsonOutput) {
    printJson({
      command: label,
      status: result.status,
      data: result.data,
    });
    return;
  }

  if (command === "list") {
    printIncidentList(result.data);
    return;
  }
  if (command === "signals") {
    printSignals(result.data);
    return;
  }
  if (command === "ai-summary") {
    printAiSummary(result.data);
    return;
  }
  if (label.startsWith("maintenance")) {
    printMaintenance(result.data);
    return;
  }
  printIncidentDetails(result.data);
}

void main().catch((error) => {
  const asError = error as Error & { status?: number; data?: unknown };
  const jsonOutput = process.argv.includes("--json");
  if (jsonOutput) {
    printJson({
      ok: false,
      error: asError.message,
      status: asError.status,
      data: asError.data,
    });
  } else {
    console.error(asError.message);
    if (asError.data !== undefined) {
      printJson(asError.data);
    }
  }
  process.exit(1);
});
