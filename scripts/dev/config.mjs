import { findExecutable } from "../lib/platform.mjs";
import { createSocket } from "node:dgram";
import { createServer, isIPv4 } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FailureKind, failure } from "./model.mjs";
import { identityPaths } from "./identity.mjs";
import ports from "./ports.json" with { type: "json" };
import sfuNode from "../../features/media/sfu/internal/config/node.json" with { type: "json" };

export const DevCommand = Object.freeze({
  START: "start",
  STATUS: "status",
  LOGS: "logs",
  STOP: "stop",
  RESET: "reset",
  DOCTOR: "doctor",
  DOWN: "down",
  HELP: "help",
});

const commands = new Set(Object.values(DevCommand));
const { metro: metroPort, ...localPorts } = ports;
const defaultPorts = Object.freeze(localPorts);
export const chalkSfuPlane = "chalk_sfu";
const toolByProfile = Object.freeze({
  core: ["node", "pnpm", "docker"],
  mobile: ["node", "pnpm", "docker", "adb", "java"],
  android: ["node", "pnpm", "docker", "adb", "java"],
  ios: ["node", "pnpm", "docker", "xcrun"],
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
  let ready = false;
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
      if (!Object.hasOwn(toolByProfile, value)) throw failure(FailureKind.CONFIG, `unknown profile: ${value}`, { stage: "arguments" });
      profile = value;
      continue;
    }
    if (token === "--fresh") {
      fresh = true;
      continue;
    }
    if (token === "--ready") {
      ready = true;
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
  if (ready && command !== DevCommand.STATUS) throw failure(FailureKind.CONFIG, "--ready is only available for status", { stage: "arguments" });
  return { command, profile, service, fresh, yes, ready };
}

// PUBLIC_ORIGIN is the one address the outside world uses: the token issuer, CORS, and the Sync URL the browser dials.
function publicOriginFromEnv(env) {
  const raw = env.PUBLIC_ORIGIN?.trim();
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw failure(FailureKind.CONFIG, "PUBLIC_ORIGIN must be an absolute http(s) origin", { stage: "config" });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username) {
    throw failure(FailureKind.CONFIG, "PUBLIC_ORIGIN must be an origin with no path, query, fragment or credentials", { stage: "config" });
  }
  return url.origin;
}

function sfuMediaFromEnv(env) {
  const announceIP = env.CHALK_DEV_SFU_ANNOUNCE_IP?.trim();
  if (!announceIP) return { announceIP: "127.0.0.1", bindIP: "127.0.0.1", includeLoopback: true };
  const firstOctet = Number(announceIP.split(".")[0]);
  if (!isIPv4(announceIP) || firstOctet === 0 || firstOctet === 127 || firstOctet >= 224) {
    throw failure(FailureKind.CONFIG, "CHALK_DEV_SFU_ANNOUNCE_IP must be a non-loopback unicast IPv4 address", { stage: "config" });
  }
  return { announceIP, bindIP: "0.0.0.0", includeLoopback: false };
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
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "chalk");
  if (platform === "darwin") return join(home, "Library", "Application Support", "chalk");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "chalk");
}

export function resolveDevConfig({ cwd = process.cwd(), root = cwd, env = process.env, platform = process.platform, home = homedir(), profile = "core", fresh = false, requiredTools, allowBusyPorts = [] } = {}) {
  if (!Object.hasOwn(toolByProfile, profile)) throw failure(FailureKind.CONFIG, `unknown profile: ${profile}`, { stage: "config" });
  const checkoutRoot = resolve(root);
  const stateRoot = env.CHALK_DEV_STATE_ROOT || userStateRoot({ env, platform, home });
  const runtimeRoot = join(checkoutRoot, ".private", "chalk-dev");
  const logRoot = join(checkoutRoot, ".logs", "dev");
  const redisPort = env.CHALK_REDIS_PORT ? numberFromEnv(env, "CHALK_REDIS_PORT", 6380) : numberFromEnv(env, "CHALK_DEV_REDIS_PORT", 6380);
  const ports = {
    api: numberFromEnv(env, "CHALK_DEV_API_PORT", defaultPorts.api),
    sync: numberFromEnv(env, "CHALK_DEV_SYNC_PORT", defaultPorts.sync),
    web: numberFromEnv(env, "CHALK_DEV_WEB_PORT", defaultPorts.web),
    postgres: numberFromEnv(env, "CHALK_DEV_POSTGRES_PORT", defaultPorts.postgres),
    redis: redisPort,
    providerBridge: numberFromEnv(env, "CHALK_DEV_PROVIDER_BRIDGE_PORT", defaultPorts.providerBridge),
    sfuMedia: numberFromEnv(env, "CHALK_DEV_SFU_MEDIA_PORT", sfuNode.ports.media),
  };
  const publicOrigin = publicOriginFromEnv(env);
  const sourceRoots = [join(checkoutRoot, "apps", "api"), join(checkoutRoot, "apps", "sync")];
  if (profile !== "core") sourceRoots.push(join(checkoutRoot, "apps", "mobile"));
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
    seedPath: join(runtimeRoot, "seed.json"),
    identity: identityPaths({ runtimeRoot }),
    auth: {
      issuer: env.CHALK_SYNC_TOKEN_ISSUER || publicOrigin || "http://chalk.local",
      audience: env.CHALK_SYNC_TOKEN_AUDIENCE || "chalk-sync",
      keyId: env.CHALK_SYNC_TOKEN_KEY_ID || "local-dev",
      trustDomain: env.CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN || "chalk.local",
      environment: env.CHALK_API_ENV || "local",
    },
    databaseName: "chalk_dev",
    postgres: {
      container: env.CHALK_POSTGRES_CONTAINER || "chalk-postgres",
      volume: env.CHALK_POSTGRES_VOLUME || "chalk-postgres",
    },
    redis: {
      port: redisPort,
      container: env.CHALK_REDIS_CONTAINER || "chalk-dev-redis",
      volume: env.CHALK_REDIS_VOLUME || "chalk-dev-redis",
    },
    // Outside `ports`: preflight must not fail the core profile, or the optional Metro, on a busy 8081.
    metro: { port: numberFromEnv(env, "RCT_METRO_PORT", metroPort) },
    ports,
    sfuMedia: sfuMediaFromEnv(env),
    publicOrigin,
    urls: {
      api: `http://127.0.0.1:${ports.api}`,
      sync: `http://127.0.0.1:${ports.sync}`,
      web: `http://127.0.0.1:${ports.web}`,
      // What a browser outside this box opens; the local web URL when PUBLIC_ORIGIN is unset.
      public: publicOrigin ?? `http://127.0.0.1:${ports.web}`,
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

function probeUdpPort(port, host) {
  return new Promise((resolveProbe) => {
    const socket = createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      resolveProbe({ available: !["EADDRINUSE", "EACCES"].includes(error.code), error });
    });
    socket.bind(port, host, () => socket.close(() => resolveProbe({ available: true })));
  });
}

export async function probePort(port, host = "127.0.0.1", transport = "tcp") {
  if (transport === "udp") {
    // Windows can bind a wildcard UDP socket even when a specific interface already owns that port.
    const addresses = new Set([host]);
    if (process.platform === "win32" && host === "0.0.0.0") {
      for (const interfaces of Object.values(networkInterfaces())) {
        for (const { address, family } of interfaces) {
          if (family === "IPv4") addresses.add(address);
        }
      }
    }
    for (const address of addresses) {
      const result = await probeUdpPort(port, address);
      if (!result.available) return result;
    }
    return { available: true };
  }
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
    const host = name === "sfuMedia" ? config.sfuMedia?.bindIP : undefined;
    const result = await probe(port, host);
    if (!result.available) busy.push(`${name}:${port}`);
    if (name !== "sfuMedia") continue;
    const udp = await probe(port, host, "udp");
    if (udp.error?.code === "EACCES") {
      throw failure(FailureKind.CONFIG, `cannot bind ${name}:${port}/udp: ${udp.error.message}`, { stage: "preflight", cause: udp.error });
    }
    if (!udp.available) busy.push(`${name}:${port}/udp`);
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
  return Boolean(findExecutable(tool));
}
