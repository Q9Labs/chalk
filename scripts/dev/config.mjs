import { createServer } from "node:net";
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FailureKind, failure } from "./model.mjs";
import { identityPaths } from "./identity.mjs";

export const DevCommand = Object.freeze({
  START: "start",
  STATUS: "status",
  LOGS: "logs",
  SMOKE: "smoke",
  STOP: "stop",
  RESET: "reset",
  HELP: "help",
});

const commands = new Set(Object.values(DevCommand));
const defaultPorts = Object.freeze({
  api: 8080,
  sync: 4100,
  web: 3070,
  postgres: 5432,
  redis: 6380,
  grafana: 3000,
  loki: 3100,
  tempo: 3200,
  pyroscope: 4040,
  otlpGrpc: 4317,
  otlpHttp: 4318,
  prometheus: 9090,
  collector: 13133,
  observabilityPostgres: 55433,
  broker: 8787,
  providerBridge: 8444,
});
const toolByProfile = Object.freeze({
  core: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl", "op"],
  mobile: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl", "op", "xcrun"],
});

function parseFlagValue(token, flag, argv, index) {
  if (token === flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw failure(FailureKind.CONFIG, `${flag} requires a value`, { stage: "arguments" });
    return [value, index + 1];
  }
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return [token.slice(prefix.length), index];
  return [undefined, index];
}

export function parseArguments(argv = []) {
  let command = DevCommand.START;
  let profile = "core";
  let service;
  let fresh = false;
  let yes = false;
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") && command === DevCommand.START && positionals.length === 0 && commands.has(token)) {
      command = token;
      continue;
    }
    let value;
    [value, index] = parseFlagValue(token, "--profile", argv, index);
    if (value !== undefined) {
      if (value !== "core" && value !== "mobile") throw failure(FailureKind.CONFIG, `unknown profile: ${value}`, { stage: "arguments" });
      profile = value;
      continue;
    }
    if (token === "--fresh") {
      fresh = true;
      continue;
    }
    if (token === "--yes" || token === "-y") {
      yes = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      command = DevCommand.HELP;
      continue;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    throw failure(FailureKind.CONFIG, `unknown argument: ${token}`, { stage: "arguments" });
  }

  if (positionals.length > 1 || (positionals.length === 1 && command !== DevCommand.LOGS)) {
    throw failure(FailureKind.CONFIG, `unexpected argument: ${positionals.join(" ")}`, { stage: "arguments" });
  }
  if (command === DevCommand.LOGS) service = positionals[0];
  return { command, profile, service, fresh, yes };
}

function numberFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw failure(FailureKind.CONFIG, `${name} must be a valid port`, { stage: "config" });
  return value;
}

function durationFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw failure(FailureKind.CONFIG, `${name} must be a positive duration`, { stage: "config" });
  return value;
}

function userStateRoot({ env, platform, home }) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "chalk");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "chalk");
}

export function resolveDevConfig({ cwd = process.cwd(), root = cwd, env = process.env, platform = process.platform, home = homedir(), profile = "core", fresh = false, requiredTools, allowBusyPorts = [], secretResolver } = {}) {
  if (profile !== "core" && profile !== "mobile") throw failure(FailureKind.CONFIG, `unknown profile: ${profile}`, { stage: "config" });
  const checkoutRoot = resolve(root);
  const stateRoot = userStateRoot({ env, platform, home });
  const runtimeRoot = join(checkoutRoot, ".private", "chalk-dev");
  const logRoot = join(checkoutRoot, ".logs", "dev");
  const redisPort = env.CHALK_REDIS_PORT ? numberFromEnv(env, "CHALK_REDIS_PORT", 6380) : numberFromEnv(env, "CHALK_DEV_REDIS_PORT", 6380);
  const ports = {
    api: numberFromEnv(env, "CHALK_DEV_API_PORT", defaultPorts.api),
    sync: numberFromEnv(env, "CHALK_DEV_SYNC_PORT", defaultPorts.sync),
    web: numberFromEnv(env, "CHALK_DEV_WEB_PORT", defaultPorts.web),
    postgres: numberFromEnv(env, "CHALK_DEV_POSTGRES_PORT", defaultPorts.postgres),
    redis: redisPort,
    grafana: numberFromEnv(env, "CHALK_DEV_GRAFANA_PORT", defaultPorts.grafana),
    loki: defaultPorts.loki,
    tempo: defaultPorts.tempo,
    pyroscope: defaultPorts.pyroscope,
    otlpGrpc: defaultPorts.otlpGrpc,
    otlpHttp: defaultPorts.otlpHttp,
    prometheus: defaultPorts.prometheus,
    collector: defaultPorts.collector,
    observabilityPostgres: defaultPorts.observabilityPostgres,
    broker: numberFromEnv(env, "CHALK_DEV_BROKER_PORT", defaultPorts.broker),
    providerBridge: numberFromEnv(env, "CHALK_DEV_PROVIDER_BRIDGE_PORT", defaultPorts.providerBridge),
  };
  const sourceRoots = [join(checkoutRoot, "apps", "api"), join(checkoutRoot, "apps", "sync")];
  if (profile === "mobile") sourceRoots.push(join(checkoutRoot, "apps", "mobile"));
  return {
    cwd: resolve(cwd),
    root: checkoutRoot,
    profile,
    fresh,
    runtimeRoot,
    stateRoot,
    logRoot,
    aggregateLog: join(checkoutRoot, ".logs", "dev-server.log"),
    ownerPath: join(stateRoot, "owner.json"),
    lockPath: join(stateRoot, "lock"),
    manifestPath: join(runtimeRoot, "manifest.json"),
    identity: identityPaths({ runtimeRoot }),
    auth: {
      issuer: env.CHALK_SYNC_TOKEN_ISSUER || "http://chalk.local",
      audience: env.CHALK_SYNC_TOKEN_AUDIENCE || "chalk-sync",
      keyId: env.CHALK_SYNC_TOKEN_KEY_ID || "local-dev",
      trustDomain: env.CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN || "chalk.local",
      environment: env.CHALK_API_ENV || "local",
    },
    secretResolver,
    databaseName: "chalk_dev",
    redis: {
      port: redisPort,
      container: env.CHALK_REDIS_CONTAINER || "chalk-dev-redis",
      volume: env.CHALK_REDIS_VOLUME || "chalk-dev-redis",
    },
    ports,
    urls: {
      api: `http://127.0.0.1:${ports.api}`,
      sync: `http://127.0.0.1:${ports.sync}`,
      web: `http://127.0.0.1:${ports.web}`,
      broker: `http://127.0.0.1:${ports.broker}/local-chalk`,
    },
    sourceRoots,
    requiredTools: requiredTools || toolByProfile[profile],
    allowBusyPorts: new Set(allowBusyPorts),
    timeouts: {
      readinessMs: durationFromEnv(env, "CHALK_DEV_READINESS_TIMEOUT_MS", 120000),
      stopGraceMs: durationFromEnv(env, "CHALK_DEV_STOP_GRACE_MS", 3000),
      stopTimeoutMs: durationFromEnv(env, "CHALK_DEV_STOP_TIMEOUT_MS", 120000),
      reloadDebounceMs: durationFromEnv(env, "CHALK_DEV_RELOAD_DEBOUNCE_MS", 350),
      pollMs: durationFromEnv(env, "CHALK_DEV_POLL_MS", 250),
    },
  };
}

export function probePort(port, host = "127.0.0.1") {
  return new Promise((resolveProbe) => {
    const server = createServer();
    server.once("error", (error) => resolveProbe({ available: error.code !== "EADDRINUSE", error }));
    server.listen({ port, host }, () => server.close(() => resolveProbe({ available: true })));
  });
}

export async function preflight(config, { which = async (tool) => commandExists(tool), probe = probePort, requiredTools = config.requiredTools, allowBusyPorts = config.allowBusyPorts } = {}) {
  const missing = [];
  for (const tool of requiredTools) {
    if (!(await which(tool))) missing.push(tool);
  }
  if (missing.length > 0) throw failure(FailureKind.MISSING_TOOL, `missing required tools: ${missing.join(", ")}`, { stage: "preflight" });

  const busy = [];
  for (const [name, port] of Object.entries(config.ports)) {
    if (allowBusyPorts.has(name) || allowBusyPorts.has(port)) continue;
    const result = await probe(port);
    if (!result.available) busy.push(`${name}:${port}`);
  }
  if (busy.length > 0) throw failure(FailureKind.BUSY_PORT, `ports already in use: ${busy.join(", ")}`, { stage: "preflight" });
  try {
    await access(config.root);
  } catch (error) {
    throw failure(FailureKind.CONFIG, `checkout root is not accessible: ${config.root}`, { stage: "preflight", cause: error });
  }
  return { ok: true, missing: [], busy: [] };
}

async function commandExists(tool) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveExists) => {
    const child = spawn("sh", ["-c", `command -v ${JSON.stringify(tool)}`], { stdio: "ignore" });
    child.once("error", () => resolveExists(false));
    child.once("exit", (code) => resolveExists(code === 0));
  });
}
