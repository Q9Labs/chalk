import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type E2EConfig = {
  apiBaseUrl: string;
  apiKey: string;
  tenantId: string;
  roomId: string;
  recordingId: string;
  cfRecordingId: string;
  r2TestRecordingKey: string;
  databaseUrl: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2BucketName: string;
  r2AccountId: string;
  webhookSecret: string;
  webhookPort: number;
  timeoutMs: number;
  persistent: boolean;
  requireEnv: boolean;
};

export type LoadConfigResult = { ok: true; config: E2EConfig } | { ok: false; skipped: true; reason: string } | { ok: false; skipped: false; reason: string };

function getArgValue(args: string[], prefix: string): string | undefined {
  const match = args.find((a) => a.startsWith(prefix));
  if (!match) return undefined;
  const value = match.slice(prefix.length);
  return value.length > 0 ? value : undefined;
}

function requireEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : undefined;
}

function loadDotenvIfPresent(): void {
  const dotenvPath = resolve(process.cwd(), ".env");
  if (!existsSync(dotenvPath)) return;

  const text = readFileSync(dotenvPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const cleaned = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;

    const key = cleaned.slice(0, eq).trim();
    if (!key) continue;
    if (process.env[key] != null) continue;

    let value = cleaned.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function loadConfig(argv = process.argv.slice(2)): LoadConfigResult {
  loadDotenvIfPresent();

  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      ok: false,
      skipped: true,
      reason: "Usage: bun run src/index.ts [--run] [--persistent] [--timeout-ms=300000] [--webhook-port=9876] [--require]",
    };
  }

  const requireFlag = argv.includes("--require") || process.env.CHALK_E2E_REQUIRE === "1";
  const runFlag = argv.includes("--run") || requireFlag || process.env.CHALK_E2E_RUN === "1";
  const persistent = argv.includes("--persistent");

  if (!runFlag) {
    return {
      ok: false,
      skipped: true,
      reason: "E2E harness disabled by default. Run with `--run` or set `CHALK_E2E_RUN=1` (and optionally `--require`).",
    };
  }

  const webhookPort = Number.parseInt(getArgValue(argv, "--webhook-port=") ?? process.env.WEBHOOK_PORT ?? "9876", 10);
  const timeoutMs = Number.parseInt(getArgValue(argv, "--timeout-ms=") ?? process.env.TIMEOUT_MS ?? "300000", 10);

  const webhookSecret = (process.env.WEBHOOK_SECRET?.trim() || "").length ? (process.env.WEBHOOK_SECRET as string) : `whsec_${randomUUID().replaceAll("-", "")}`;

  const missing: string[] = [];
  const requiredKeys = ["API_BASE_URL", "API_KEY", "TENANT_ID", "ROOM_ID", "RECORDING_ID", "CF_RECORDING_ID", "R2_TEST_RECORDING_KEY", "DATABASE_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ACCOUNT_ID"] as const;

  const env: Record<(typeof requiredKeys)[number], string> = {} as any;
  for (const key of requiredKeys) {
    const v = requireEnv(key);
    if (!v) missing.push(key);
    else env[key] = v;
  }

  if (missing.length > 0) {
    const reason = `Missing required env vars: ${missing.join(", ")}`;
    if (requireFlag) return { ok: false, skipped: false, reason };
    return {
      ok: false,
      skipped: true,
      reason: `${reason}. Skipping (set CHALK_E2E_REQUIRE=1 to require).`,
    };
  }

  return {
    ok: true,
    config: {
      apiBaseUrl: env.API_BASE_URL.replace(/\/+$/, ""),
      apiKey: env.API_KEY,
      tenantId: env.TENANT_ID,
      roomId: env.ROOM_ID,
      recordingId: env.RECORDING_ID,
      cfRecordingId: env.CF_RECORDING_ID,
      r2TestRecordingKey: env.R2_TEST_RECORDING_KEY,
      databaseUrl: env.DATABASE_URL,
      r2AccessKeyId: env.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: env.R2_SECRET_ACCESS_KEY,
      r2BucketName: env.R2_BUCKET_NAME,
      r2AccountId: env.R2_ACCOUNT_ID,
      webhookSecret,
      webhookPort: Number.isFinite(webhookPort) ? webhookPort : 9876,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 300000,
      persistent,
      requireEnv: requireFlag,
    },
  };
}
