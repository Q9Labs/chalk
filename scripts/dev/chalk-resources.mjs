import { resolveCommand } from "../lib/platform.mjs";
import { execFile } from "node:child_process";
import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { FailureKind, failure } from "./model.mjs";
import { preflight, probePort } from "./config.mjs";
import { containerArguments, containerNames, containerPath, imageName, prepareImages } from "./containers.mjs";
import { generateSigningIdentity } from "./identity.mjs";
import { devAPIIdentity, startChalkSfu } from "./chalk-sfu.mjs";

const execFileAsync = promisify(execFile);

export function createResourceManager(config, { runner = runChecked, docker = dockerInspect, identityGenerator = generateSigningIdentity } = {}) {
  const state = { postgres: {}, redis: {}, identity: undefined };
  const databaseName = config.databaseName || "chalk_dev";
  const postgres = config.postgres || { container: "chalk-postgres", volume: "chalk-postgres" };
  const resourceLogPath = join(config.logRoot, "resources.log");
  const scripts = {
    postgres: join(config.root, "apps/api/scripts/dev-postgres.mjs"),
    redis: join(config.root, "apps/api/scripts/dev-redis.mjs"),
    migrate: join(config.root, "apps/api/scripts/db-migrate.mjs"),
  };

  return {
    state,
    async preflight(options = {}) {
      const allowBusyPorts = new Set(config.allowBusyPorts);
      const portOwners = [
        ["postgres", postgres.container],
        ["redis", config.redis?.container || "chalk-dev-redis"],
      ];
      const containers = new Map();
      for (const [name, containerName] of portOwners) {
        const port = config.ports[name];
        if (!port) continue;
        if (!containers.has(containerName)) containers.set(containerName, await docker(containerName));
        const container = containers.get(containerName);
        if (container?.running && Array.isArray(container.hostPorts) && !container.hostPorts.includes(port)) {
          throw failure(FailureKind.CONFIG, `${containerName} is already running without configured ${name} port ${port}; use its published host port or stop the container`, { stage: "preflight" });
        }
        const result = await probePort(port);
        if (result.available) continue;
        if (adoptable(name, container)) allowBusyPorts.add(name);
      }
      return preflight(config, { ...options, allowBusyPorts });
    },
    async start({ lease } = {}) {
      await mkdir(join(config.runtimeRoot, "dashboard-artifacts"), { recursive: true });
      state.versions = await prepareImages(config, (command, args) => runResource(command, args, { cwd: config.root }, "images"));
      const network = containerNames(config).network;
      try {
        await runner("docker", ["network", "inspect", network]);
      } catch (error) {
        if (error.cause?.code !== 1 && error.code !== 1) throw error;
        await runner("docker", ["network", "create", network]);
      }
      state.postgres.before = await docker(postgres.container);
      state.redis.before = await docker(config.redis.container);
      const databaseEnv = {
        CHALK_POSTGRES_CONTAINER: postgres.container,
        CHALK_POSTGRES_VOLUME: postgres.volume,
        CHALK_POSTGRES_PORT: String(config.ports.postgres),
      };
      try {
        await runResource(process.execPath, [scripts.postgres, "start"], { cwd: config.root, env: databaseEnv }, "postgres");
      } finally {
        state.postgres.after = await docker(postgres.container);
        state.postgres.started = !state.postgres.before?.running && Boolean(state.postgres.after?.running);
      }
      await ensureDatabase();
      try {
        await runResource(
          process.execPath,
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
      for (const name of [postgres.container, config.redis.container]) {
        const { stdout } = await runner("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", name]);
        if (!JSON.parse(stdout)[network]) await runner("docker", ["network", "connect", "--alias", name === postgres.container ? "postgres" : "redis", network, name]);
      }
      await runResource(process.execPath, [scripts.migrate, "--allow-missing", "up"], { cwd: join(config.root, "apps/api"), env: { CHALK_DATABASE_URL: `postgres://postgres:postgres@${postgres.container}:5432/${databaseName}?sslmode=disable`, CHALK_DEV_NETWORK: network } }, "migrations");
      const identity = await prepareIdentity(config, identityGenerator, lease?.runtimeId || "00000000-0000-4000-8000-000000000000", async (args) => {
        const containerArgs = args.map((arg) => (arg.startsWith(config.root) ? containerPath(config, arg) : arg));
        await runResource("docker", containerArguments(config, "api", { image: imageName("api", state.versions), command: ["openssl", ...containerArgs] }), { cwd: config.root }, "identity");
      });
      state.identity = { ...identity, generatedAt: new Date().toISOString() };
      await startChalkSfu(config, { network, versions: state.versions, runResource });
    },
    async stop() {
      await stopContainers();
      if (state.redis.started) await runResource(process.execPath, [scripts.redis, "stop"], { cwd: config.root, env: { CHALK_REDIS_CONTAINER: config.redis.container, CHALK_REDIS_PORT: String(config.redis.port) } }, "redis").catch(() => {});
      if (state.postgres.started) await runResource(process.execPath, [scripts.postgres, "stop"], { cwd: config.root, env: { CHALK_POSTGRES_CONTAINER: postgres.container, CHALK_POSTGRES_PORT: String(config.ports.postgres) } }, "postgres").catch(() => {});
    },
    stopContainers,
    async reset() {
      await runResource(
        process.execPath,
        [scripts.redis, "wipe"],
        {
          cwd: config.root,
          env: { CHALK_REDIS_CONTAINER: config.redis.container, CHALK_REDIS_VOLUME: config.redis.volume, CHALK_REDIS_PORT: String(config.redis.port) },
        },
        "redis",
      );
      await resetDatabase();
    },
    logPaths: { resources: resourceLogPath },
  };

  async function removeNetwork() {
    const network = containerNames(config).network;
    let details;
    try {
      details = await runner("docker", ["network", "inspect", network]);
    } catch (error) {
      if ((error.cause?.code || error.code) === 1) return;
      throw error;
    }
    const [record] = JSON.parse(details.stdout);
    for (const container of Object.values(record.Containers || {})) await runner("docker", ["network", "disconnect", network, container.Name]);
    await runner("docker", ["network", "rm", network]);
  }

  async function stopContainers() {
    for (const name of [containerNames(config).sync, containerNames(config).api, containerNames(config).sfu]) {
      if (await docker(name)) await runResource("docker", ["rm", "--force", name], { cwd: config.root }, "containers");
    }
  }

  async function ensureDatabase() {
    const result = await runResource("docker", ["exec", postgres.container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`], { cwd: config.root }, "postgres");
    if (result?.stdout?.trim()) return;
    await runResource("docker", ["exec", postgres.container, "psql", "-U", "postgres", "-d", "postgres", "-c", `CREATE DATABASE "${databaseName}"`], { cwd: config.root }, "postgres");
  }

  async function resetDatabase() {
    const before = await docker(postgres.container);
    const env = {
      CHALK_POSTGRES_CONTAINER: postgres.container,
      CHALK_POSTGRES_VOLUME: postgres.volume,
      CHALK_POSTGRES_PORT: String(config.ports.postgres),
    };
    let startedForReset = false;
    if (!before?.running) {
      await runResource(process.execPath, [scripts.postgres, "start"], { cwd: config.root, env }, "postgres");
      startedForReset = true;
    }
    try {
      await runResource("docker", ["exec", postgres.container, "psql", "-U", "postgres", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`], { cwd: config.root }, "postgres");
      await runResource("docker", ["exec", postgres.container, "psql", "-U", "postgres", "-d", "postgres", "-c", `CREATE DATABASE "${databaseName}"`], { cwd: config.root }, "postgres");
    } finally {
      await removeNetwork();
      if (startedForReset) await runResource(process.execPath, [scripts.postgres, "stop"], { cwd: config.root, env }, "postgres").catch(() => {});
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
  if (name === "redis" && !image.startsWith("redis:8.10")) return false;
  return true;
}

async function prepareIdentity(config, identityGenerator = generateSigningIdentity, runtimeId, openssl) {
  if (!openssl) throw new Error("TLS identity generation requires the dev API container");
  const signing = await identityGenerator({ paths: config.identity, kid: config.auth.keyId });
  const extRoot = config.identity.root;
  await mkdir(extRoot, { recursive: true, mode: 0o700 });
  const serial = join(extRoot, "local-ca.srl");
  const apiExt = join(extRoot, "api.ext");
  const syncExt = join(extRoot, "sync.ext");
  const sfuExt = join(extRoot, "sfu.ext");
  await writeFile(apiExt, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:localhost,DNS:api,IP:127.0.0.1,URI:${devAPIIdentity(config)}\n`, { mode: 0o600 });
  await writeFile(syncExt, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:spiffe://${config.auth.trustDomain || "chalk.local"}/environment/${config.auth.environment || "local"}/sync/${runtimeId}\n`, { mode: 0o600 });
  try {
    await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", config.identity.caKey, "-out", config.identity.caCertificate, "-subj", "/CN=chalk-local-ca", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    await makeLeaf(config.identity.apiKey, config.identity.apiCertificate, "/CN=chalk-api-provider-bridge", apiExt, config.identity.caCertificate, config.identity.caKey, serial, openssl, true);
    await makeLeaf(config.identity.syncKey, config.identity.syncCertificate, "/CN=chalk-sync-provider-bridge", syncExt, config.identity.caCertificate, config.identity.caKey, serial, openssl);
    await writeFile(sfuExt, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:sfu\n", { mode: 0o600 });
    await makeLeaf(config.identity.sfuKey, config.identity.sfuCertificate, "/CN=chalk-sfu", sfuExt, config.identity.caCertificate, config.identity.caKey, serial, openssl);
  } finally {
    await Promise.all([unlink(sfuExt).catch(() => {}), unlink(apiExt).catch(() => {}), unlink(syncExt).catch(() => {}), unlink(serial).catch(() => {})]);
  }
  return { signing, paths: config.identity };
}

async function makeLeaf(keyPath, certPath, subject, extensionPath, caPath, caKeyPath, serialPath, openssl, createSerial = false) {
  const csrPath = `${certPath}.csr`;
  try {
    await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath, "-subj", subject]);
    await openssl(["x509", "-req", "-in", csrPath, "-CA", caPath, "-CAkey", caKeyPath, "-CAserial", serialPath, ...(createSerial ? ["-CAcreateserial"] : []), "-out", certPath, "-days", "2", "-sha256", "-extfile", extensionPath]);
  } finally {
    await unlink(csrPath).catch(() => {});
  }
}

async function dockerInspect(name) {
  try {
    const { stdout } = await execFileAsync("docker", ["container", "inspect", name], { encoding: "utf8" });
    const [container] = JSON.parse(stdout);
    let dataChecksums;
    if (String(container?.Config?.Image || "").startsWith("postgres:") && container?.State?.Running === true) {
      try {
        const result = await execFileAsync("docker", ["exec", name, "psql", "-U", "postgres", "-d", "postgres", "-tAc", "show data_checksums"], { encoding: "utf8" });
        dataChecksums = result.stdout.trim();
      } catch {
        dataChecksums = undefined;
      }
    }
    const hostPorts = Object.values(container?.NetworkSettings?.Ports || {})
      .flatMap((bindings) => bindings || [])
      .map((binding) => Number(binding.HostPort))
      .filter(Number.isInteger);
    return { running: container?.State?.Running === true, healthy: container?.State?.Health?.Status === "healthy", image: container?.Config?.Image, dataChecksums, hostPorts, name };
  } catch (error) {
    if (error.code === 1 || error.code === "ENOENT") return undefined;
    throw failure(FailureKind.IO, `docker inspect failed for ${name}`, { stage: "preflight", cause: error });
  }
}

export async function runChecked(command, args, { cwd, env = {} } = {}) {
  try {
    const childEnv = { ...process.env, ...env };
    const resolved = resolveCommand(command, args, { env: childEnv });
    return await execFileAsync(resolved.file, resolved.args, { windowsVerbatimArguments: resolved.windowsVerbatimArguments, cwd, env: childEnv, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = String(error.stderr || error.message || "").replace(/(postgres:\/\/[^\s]+|Bearer\s+[^\s]+)/gi, "[redacted]");
    throw failure(FailureKind.STARTUP, `${command} ${args[0] || ""} failed${detail ? `: ${detail.slice(-500)}` : ""}`, { stage: "resources", cause: error });
  }
}
