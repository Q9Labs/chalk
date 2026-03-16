import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const mobileEnvPath = resolve(repoRoot, "apps/mobile/.env.local");
const webEnvPath = resolve(repoRoot, "apps/web/.env.local");
const defaultApiUrl = "http://localhost:8080";
const defaultWsUrl = "ws://localhost:8080/ws";

type EnvMap = Map<string, string>;

function readEnvFile(path: string): { lines: string[]; map: EnvMap } {
  if (!existsSync(path)) {
    return { lines: [], map: new Map() };
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const map = new Map<string, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1);
    map.set(key, value);
  }

  return { lines, map };
}

function upsertEnvLine(lines: string[], key: string, value: string): string[] {
  const nextLine = `${key}=${value}`;
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) {
    const next = [...lines];
    next[index] = nextLine;
    return next;
  }
  return [...lines.filter((line, idx, all) => !(idx === all.length - 1 && line === "")), nextLine];
}

function writeEnvFile(path: string, lines: string[]): void {
  const normalized = [...lines];
  if (normalized.length === 0 || normalized[normalized.length - 1] !== "") {
    normalized.push("");
  }
  writeFileSync(path, normalized.join("\n"), "utf8");
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; json: any }> {
  const response = await fetch(url, init);
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function isApiKeyValid(apiUrl: string, apiKey: string | null | undefined): Promise<boolean> {
  if (!apiKey) return false;
  const response = await fetchJson(`${apiUrl}/api/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  return response.status === 200;
}

async function createLocalTenant(apiUrl: string): Promise<{ apiKey: string; tenantId: string }> {
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const response = await fetchJson(`${apiUrl}/api/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `Chalk Mobile Local ${suffix}`,
      max_concurrent_rooms: 100,
      max_participants_per_room: 20,
      max_recording_duration_minutes: 120,
    }),
  });

  if (response.status !== 201 || !response.json?.api_key || !response.json?.tenant?.id) {
    throw new Error(`Failed to create local tenant (${response.status})`);
  }

  return {
    apiKey: response.json.api_key,
    tenantId: response.json.tenant.id,
  };
}

async function main(): Promise<void> {
  const mobileEnv = readEnvFile(mobileEnvPath);
  const webEnv = readEnvFile(webEnvPath);
  const apiUrl = mobileEnv.map.get("EXPO_PUBLIC_API_URL") || webEnv.map.get("VITE_API_URL") || defaultApiUrl;
  const wsUrl = mobileEnv.map.get("EXPO_PUBLIC_WS_URL") || webEnv.map.get("VITE_WS_URL") || defaultWsUrl;

  let apiKey = webEnv.map.get("VITE_CHALK_API_KEY") || mobileEnv.map.get("EXPO_PUBLIC_CHALK_API_KEY") || "";
  let tenantId = webEnv.map.get("VITE_CHALK_TENANT_ID") || "";

  const webKeyValid = await isApiKeyValid(apiUrl, apiKey);

  if (!webKeyValid) {
    const created = await createLocalTenant(apiUrl);
    apiKey = created.apiKey;
    tenantId = created.tenantId;
    console.log(`[sync-local-mobile-env] created fresh local tenant ${tenantId}`);
  } else {
    console.log("[sync-local-mobile-env] reusing valid local web tenant key");
  }

  let nextMobileLines = mobileEnv.lines;
  nextMobileLines = upsertEnvLine(nextMobileLines, "EXPO_PUBLIC_API_URL", defaultApiUrl);
  nextMobileLines = upsertEnvLine(nextMobileLines, "EXPO_PUBLIC_WS_URL", defaultWsUrl);
  nextMobileLines = upsertEnvLine(nextMobileLines, "EXPO_PUBLIC_CHALK_API_KEY", apiKey);
  writeEnvFile(mobileEnvPath, nextMobileLines);

  let nextWebLines = webEnv.lines;
  nextWebLines = upsertEnvLine(nextWebLines, "VITE_API_URL", defaultApiUrl);
  nextWebLines = upsertEnvLine(nextWebLines, "VITE_WS_URL", defaultWsUrl);
  nextWebLines = upsertEnvLine(nextWebLines, "VITE_CHALK_API_KEY", apiKey);
  if (tenantId) {
    nextWebLines = upsertEnvLine(nextWebLines, "VITE_CHALK_TENANT_ID", tenantId);
  }
  writeEnvFile(webEnvPath, nextWebLines);

  console.log("[sync-local-mobile-env] synced local web/mobile host auth");
}

void main().catch((error) => {
  console.error(`[sync-local-mobile-env] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
