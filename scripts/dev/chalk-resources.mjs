import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { FailureKind, failure } from "./model.mjs";
import { preflight, probePort } from "./config.mjs";
import { generateSigningIdentity } from "./identity.mjs";

const execFileAsync = promisify(execFile);

const observabilityPortOwners = Object.freeze([
  ["grafana", "chalk-observability-lgtm"],
  ["loki", "chalk-observability-lgtm"],
  ["tempo", "chalk-observability-lgtm"],
  ["pyroscope", "chalk-observability-lgtm"],
  ["otlpGrpc", "chalk-observability-lgtm"],
  ["otlpHttp", "chalk-observability-lgtm"],
  ["prometheus", "chalk-observability-lgtm"],
  ["collector", "chalk-observability-lgtm"],
  ["observabilityPostgres", "chalk-observability-postgres"],
]);

export function createResourceManager(config, { runner = runChecked, docker = dockerInspect, identityGenerator = generateSigningIdentity } = {}) {
  const state = { postgres: {}, redis: {}, observability: {}, identity: undefined };
  const databaseName = config.databaseName || "chalk_dev";
  const resourceLogPath = join(config.logRoot, "observability.log");
  const scripts = {
    postgres: join(config.root, "apps/api/scripts/dev-postgres.sh"),
    redis: join(config.root, "apps/api/scripts/dev-redis.sh"),
    services: join(config.root, "infrastructure/observability/scripts/local.sh"),
    migrate: join(config.root, "apps/api/scripts/db-migrate.sh"),
  };

  return {
    state,
    async preflight(options = {}) {
      const allowBusyPorts = new Set(config.allowBusyPorts);
      const portOwners = [["postgres", "chalk-postgres"], ["redis", config.redis?.container || "chalk-dev-redis"], ...observabilityPortOwners];
      const containers = new Map();
      for (const [name, containerName] of portOwners) {
        const port = config.ports[name];
        if (!port) continue;
        const result = await probePort(port);
        if (result.available) continue;
        if (!containers.has(containerName)) containers.set(containerName, await docker(containerName));
        if (adoptable(name, containers.get(containerName))) allowBusyPorts.add(name);
      }
      return preflight(config, { ...options, allowBusyPorts });
    },
    async start({ lease } = {}) {
      state.postgres.before = await docker("chalk-postgres");
      state.redis.before = await docker(config.redis.container);
      state.observability.before = await docker("chalk-observability-lgtm");
      const databaseEnv = {
        CHALK_POSTGRES_CONTAINER: "chalk-postgres",
        CHALK_POSTGRES_VOLUME: "chalk-postgres",
        CHALK_POSTGRES_PORT: String(config.ports.postgres),
      };
      const observabilityEnv = {
        CHALK_OBSERVABILITY_LEDGER_TARGET: "api",
        CHALK_GRAFANA_LEDGER_DATABASE: databaseName,
        CHALK_GRAFANA_LEDGER_URL: "host.docker.internal:5432",
        CHALK_OBSERVABILITY_POSTGRES_PORT: String(config.ports.observabilityPostgres),
      };
      try {
        await runResource("bash", [scripts.postgres, "start"], { cwd: config.root, env: databaseEnv }, "postgres");
      } finally {
        state.postgres.after = await docker("chalk-postgres");
        state.postgres.started = !state.postgres.before?.running && Boolean(state.postgres.after?.running);
      }
      await ensureDatabase();
      try {
        await runResource(
          "bash",
          [scripts.redis, "start"],
          {
            cwd: config.root,
            env: {
              CHALK_REDIS_CONTAINER: config.redis.container,
              CHALK_REDIS_VOLUME: config.redis.volume,
              CHALK_REDIS_PORT: String(config.redis.port),
            },
          },
          "redis",
        );
      } finally {
        state.redis.after = await docker(config.redis.container);
        state.redis.started = !state.redis.before?.running && Boolean(state.redis.after?.running);
      }
      try {
        await runResource("bash", [scripts.services, "start"], { cwd: config.root, env: observabilityEnv }, "observability");
      } finally {
        state.observability.after = await docker("chalk-observability-lgtm");
        state.observability.started = !state.observability.before?.running && Boolean(state.observability.after?.running);
      }
      await runResource("bash", [scripts.migrate, "--allow-missing", "up"], { cwd: join(config.root, "apps/api"), env: { CHALK_DATABASE_URL: databaseURL(config) } }, "migrations");
      const identity = await prepareIdentity(config, identityGenerator, lease?.runtimeId || "00000000-0000-4000-8000-000000000000");
      state.identity = { ...identity, generatedAt: new Date().toISOString() };
    },
    async stop() {
      if (state.observability.started)
        await runResource(
          "bash",
          [scripts.services, "stop"],
          { cwd: config.root, env: { CHALK_OBSERVABILITY_LEDGER_TARGET: "api", CHALK_GRAFANA_LEDGER_DATABASE: databaseName, CHALK_GRAFANA_LEDGER_URL: "host.docker.internal:5432", CHALK_OBSERVABILITY_POSTGRES_PORT: String(config.ports.observabilityPostgres) } },
          "observability",
        ).catch(() => {});
      if (state.redis.started) await runResource("bash", [scripts.redis, "stop"], { cwd: config.root, env: { CHALK_REDIS_CONTAINER: config.redis.container, CHALK_REDIS_PORT: String(config.redis.port) } }, "redis").catch(() => {});
      if (state.postgres.started) await runResource("bash", [scripts.postgres, "stop"], { cwd: config.root, env: { CHALK_POSTGRES_CONTAINER: "chalk-postgres", CHALK_POSTGRES_PORT: String(config.ports.postgres) } }, "postgres").catch(() => {});
    },
    async reset() {
      await runResource(
        "bash",
        [scripts.services, "reset"],
        {
          cwd: config.root,
          env: { CHALK_OBSERVABILITY_LEDGER_TARGET: "api", CHALK_GRAFANA_LEDGER_DATABASE: databaseName, CHALK_GRAFANA_LEDGER_URL: "host.docker.internal:5432", CHALK_OBSERVABILITY_POSTGRES_PORT: String(config.ports.observabilityPostgres) },
        },
        "observability",
      );
      await runResource(
        "bash",
        [scripts.redis, "wipe"],
        {
          cwd: config.root,
          env: { CHALK_REDIS_CONTAINER: config.redis.container, CHALK_REDIS_VOLUME: config.redis.volume, CHALK_REDIS_PORT: String(config.redis.port) },
        },
        "redis",
      );
      await resetDatabase();
    },
    logPaths: { observability: resourceLogPath },
  };

  async function ensureDatabase() {
    const result = await runResource("docker", ["exec", "chalk-postgres", "psql", "-U", "postgres", "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`], { cwd: config.root }, "postgres");
    if (result?.stdout?.trim()) return;
    await runResource("docker", ["exec", "chalk-postgres", "psql", "-U", "postgres", "-d", "postgres", "-c", `CREATE DATABASE "${databaseName}"`], { cwd: config.root }, "postgres");
  }

  async function resetDatabase() {
    const before = await docker("chalk-postgres");
    const env = {
      CHALK_POSTGRES_CONTAINER: "chalk-postgres",
      CHALK_POSTGRES_VOLUME: "chalk-postgres",
      CHALK_POSTGRES_PORT: String(config.ports.postgres),
    };
    let startedForReset = false;
    if (!before?.running) {
      await runResource("bash", [scripts.postgres, "start"], { cwd: config.root, env }, "postgres");
      startedForReset = true;
    }
    try {
      await runResource("docker", ["exec", "chalk-postgres", "psql", "-U", "postgres", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`], { cwd: config.root }, "postgres");
      await runResource("docker", ["exec", "chalk-postgres", "psql", "-U", "postgres", "-d", "postgres", "-c", `CREATE DATABASE "${databaseName}"`], { cwd: config.root }, "postgres");
    } finally {
      if (startedForReset) await runResource("bash", [scripts.postgres, "stop"], { cwd: config.root, env }, "postgres").catch(() => {});
    }
  }

  async function runResource(command, args, options, service) {
    try {
      const result = await runner(command, args, options);
      await writeResourceLog(service, result?.stdout);
      await writeResourceLog(service, result?.stderr);
      return result;
    } catch (error) {
      await writeResourceLog(service, error.stderr || error.message);
      throw error;
    }
  }

  async function writeResourceLog(service, text) {
    if (!text) return;
    const safe = redactResourceOutput(text);
    await mkdir(config.logRoot, { recursive: true, mode: 0o700 });
    const line = `[${new Date().toISOString()}] ${safe}`;
    await appendFile(join(config.logRoot, `${service}.log`), line, "utf8");
    await appendFile(config.aggregateLog, `[${service}] ${line}`, "utf8");
  }
}

function redactResourceOutput(text) {
  return String(text)
    .replace(/postgres:\/\/[^\s]+/gi, "postgres://[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
}

function adoptable(name, container) {
  if (!container?.running) return false;
  const image = String(container.image || "");
  if (name === "postgres" && (!image.startsWith("postgres:18.3") || container.dataChecksums !== "on")) return false;
  if (name === "redis" && !image.startsWith("redis:8.8")) return false;
  if (name === "observabilityPostgres" && !image.startsWith("postgres:18.3")) return false;
  if (observabilityPortOwners.some(([portName]) => portName === name && portName !== "observabilityPostgres")) {
    if (!image.startsWith("grafana/otel-lgtm:0.28.0")) return false;
    if (container.healthy === false) return false;
  }
  return true;
}

async function prepareIdentity(config, identityGenerator = generateSigningIdentity, runtimeId) {
  const signing = await identityGenerator({ paths: config.identity, kid: config.auth.keyId });
  const extRoot = config.identity.root;
  await mkdir(extRoot, { recursive: true, mode: 0o700 });
  const serial = join(extRoot, "local-ca.srl");
  const apiExt = join(extRoot, "api.ext");
  const syncExt = join(extRoot, "sync.ext");
  await writeFile(apiExt, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n", { mode: 0o600 });
  await writeFile(syncExt, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:spiffe://${config.auth.trustDomain || "chalk.local"}/environment/${config.auth.environment || "local"}/sync/${runtimeId}\n`, { mode: 0o600 });
  try {
    await runChecked("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      config.identity.caKey,
      "-out",
      config.identity.caCertificate,
      "-subj",
      "/CN=chalk-local-ca",
      "-days",
      "2",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    await makeLeaf(config.identity.apiKey, config.identity.apiCertificate, "/CN=chalk-api-provider-bridge", apiExt, config.identity.caCertificate, config.identity.caKey, serial, true);
    await makeLeaf(config.identity.syncKey, config.identity.syncCertificate, "/CN=chalk-sync-provider-bridge", syncExt, config.identity.caCertificate, config.identity.caKey, serial);
  } finally {
    await Promise.all([unlink(apiExt).catch(() => {}), unlink(syncExt).catch(() => {}), unlink(serial).catch(() => {})]);
  }
  await Promise.all([config.identity.caKey, config.identity.apiKey, config.identity.syncKey].map((path) => chmod(path, 0o600)));
  return { signing, paths: config.identity };
}

async function makeLeaf(keyPath, certPath, subject, extensionPath, caPath, caKeyPath, serialPath, createSerial = false) {
  const csrPath = `${certPath}.csr`;
  try {
    await runChecked("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath, "-subj", subject]);
    await runChecked("openssl", ["x509", "-req", "-in", csrPath, "-CA", caPath, "-CAkey", caKeyPath, "-CAserial", serialPath, ...(createSerial ? ["-CAcreateserial"] : []), "-out", certPath, "-days", "2", "-sha256", "-extfile", extensionPath]);
  } finally {
    await unlink(csrPath).catch(() => {});
  }
}

function databaseURL(config) {
  return `postgres://postgres:postgres@127.0.0.1:${config.ports.postgres}/${config.databaseName || "chalk_dev"}?sslmode=disable`;
}

async function dockerInspect(name) {
  try {
    const { stdout } = await execFileAsync("docker", ["container", "inspect", name], { encoding: "utf8" });
    const [container] = JSON.parse(stdout);
    let dataChecksums;
    if (name === "chalk-postgres" && container?.State?.Running === true) {
      try {
        const result = await execFileAsync("docker", ["exec", name, "psql", "-U", "postgres", "-d", "postgres", "-tAc", "show data_checksums"], { encoding: "utf8" });
        dataChecksums = result.stdout.trim();
      } catch {
        dataChecksums = undefined;
      }
    }
    return { running: container?.State?.Running === true, healthy: container?.State?.Health?.Status === "healthy", image: container?.Config?.Image, dataChecksums, name };
  } catch (error) {
    if (error.code === 1 || error.code === "ENOENT") return undefined;
    throw failure(FailureKind.IO, `docker inspect failed for ${name}`, { stage: "preflight", cause: error });
  }
}

export async function runChecked(command, args, { cwd, env = {} } = {}) {
  try {
    return await execFileAsync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = String(error.stderr || error.message || "").replace(/(postgres:\/\/[^\s]+|Bearer\s+[^\s]+)/gi, "[redacted]");
    throw failure(FailureKind.STARTUP, `${command} ${args[0] || ""} failed${detail ? `: ${detail.slice(-500)}` : ""}`, { stage: "resources", cause: error });
  }
}
