#!/usr/bin/env node
// Minimal local Chalk stack for the web-app profiling harness.
//
// The supervised `pnpm dev` stack still requires a broker Worker whose source
// was removed from the repo (scripts/dev/chalk.mjs discoverBrokerRuntime), so
// this script starts only what the Space web app actually needs:
//   postgres + redis containers, migrations, Go API (+ provider bridge),
//   Elixir sync server, and the Vite Space web server.
// Observability is intentionally left off to keep profiles clean.
//
// Usage: node dev-stack.mjs [--up] [--down]
// State and logs live under .private/chalk-perf/.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const runtimeRoot = join(repoRoot, ".private", "chalk-perf");

const PORTS = { api: 18080, sync: 4100, web: 13070, postgres: 5432, redis: 6380, objectStorage: 19000 };
const DATABASE_NAME = "chalk_perf_profile";
const URLS = {
  api: `http://127.0.0.1:${PORTS.api}`,
  sync: `ws://127.0.0.1:${PORTS.sync}/v1/sync`,
  web: `http://127.0.0.1:${PORTS.web}`,
};
const DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PORTS.postgres}/${DATABASE_NAME}?sslmode=disable`;
const RUSTFS_IMAGE = "rustfs/rustfs:1.0.0-beta.10@sha256:60f4f2f41ce95216f8cac676e69f9d90c0bfec458a3bc7fd7fb9b7c2452ac57a";
const OBJECT_STORAGE_STATE_PATH = join(runtimeRoot, "object-storage.json");
const OBJECT_STORAGE_OWNER_LABEL = "com.q9labs.chalk.perf.object-storage-owner";
const OBJECT_STORAGE_ROLE_LABEL = "com.q9labs.chalk.perf.object-storage-role";

const children = new Map();
let objectStorage = null;
let stopping = false;

function log(message) {
  process.stdout.write(`[dev-stack] ${message}\n`);
}

async function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd ?? repoRoot, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("exit", (code) => resolve({ code, out, err }));
    child.on("error", (error) => resolve({ code: -1, out, err: String(error) }));
  });
  if (result.code !== 0 && !options.tolerateFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.code})\n${result.out}\n${result.err}`);
  }
  return result;
}

function spawnService(name, command, args, { cwd, env, logFile }) {
  log(`start ${name}: ${command} ${args.join(" ")}`);
  const stream = createWriteStream(logFile, { flags: "a" });
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => stream.write(chunk));
  child.stderr.on("data", (chunk) => stream.write(chunk));
  const restarts = serviceRestarts.get(name) ?? 0;
  child.on("exit", (code) => {
    stream.end();
    children.delete(name);
    if (stopping) return;
    if (code === 0 || code === null) return;
    log(`service ${name} exited with ${code} (see ${logFile})`);
    if (restarts < 5) {
      serviceRestarts.set(name, restarts + 1);
      log(`restarting ${name} (attempt ${restarts + 1}/5) in 2s`);
      setTimeout(() => spawnService(name, command, args, { cwd, env, logFile }), 2_000);
    }
  });
  children.set(name, child);
}

const serviceRestarts = new Map();

async function waitFor(url, label, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        log(`ready: ${label}`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${label} at ${url}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadObjectStorageState() {
  try {
    return JSON.parse(await readFile(OBJECT_STORAGE_STATE_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function objectStorageCredentials() {
  return {
    AWS_ACCESS_KEY_ID: objectStorage.accessKeyID,
    AWS_SECRET_ACCESS_KEY: objectStorage.secretAccessKey,
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

async function startObjectStorage() {
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const ownerLabel = `chalk-perf-${process.pid}-${suffix}`;
  const containerName = `chalk-perf-rustfs-${process.pid}-${suffix}`;
  const volumeName = `chalk-perf-rustfs-data-${process.pid}-${suffix}`;
  const bucket = `chalk-perf-${suffix}`.toLowerCase();
  const accessKeyID = `chalkperf${randomBytes(6).toString("hex")}`;
  const secretAccessKey = `chalkperf${randomBytes(12).toString("hex")}`;
  const rpcSecret = `chalkrpc${randomBytes(24).toString("hex")}`;
  const endpoint = `http://127.0.0.1:${PORTS.objectStorage}`;

  objectStorage = { accessKeyID, bucket, containerName, endpoint, ownerLabel, rpcSecret, secretAccessKey, volumeName };
  await writeFile(
    OBJECT_STORAGE_STATE_PATH,
    JSON.stringify(
      {
        containerName,
        ownerLabel,
        bucket,
        endpoint,
        role: "rustfs",
        volumeName,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  try {
    await run("docker", ["volume", "create", "--label", `${OBJECT_STORAGE_OWNER_LABEL}=${ownerLabel}`, "--label", `${OBJECT_STORAGE_ROLE_LABEL}=rustfs`, volumeName]);
    await run(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        containerName,
        "--label",
        `${OBJECT_STORAGE_OWNER_LABEL}=${ownerLabel}`,
        "--label",
        `${OBJECT_STORAGE_ROLE_LABEL}=rustfs`,
        "--publish",
        `127.0.0.1:${PORTS.objectStorage}:9000`,
        "--volume",
        `${volumeName}:/data`,
        "--env",
        "RUSTFS_ACCESS_KEY",
        "--env",
        "RUSTFS_SECRET_KEY",
        "--env",
        "RUSTFS_RPC_SECRET",
        "--env",
        "RUSTFS_ADDRESS",
        "--env",
        "RUSTFS_CONSOLE_ENABLE",
        "--env",
        "RUSTFS_CORS_ALLOWED_ORIGINS",
        "--env",
        "RUSTFS_REGION",
        RUSTFS_IMAGE,
      ],
      {
        env: {
          RUSTFS_ACCESS_KEY: accessKeyID,
          RUSTFS_SECRET_KEY: secretAccessKey,
          RUSTFS_RPC_SECRET: rpcSecret,
          RUSTFS_ADDRESS: "0.0.0.0:9000",
          RUSTFS_CONSOLE_ENABLE: "false",
          RUSTFS_CORS_ALLOWED_ORIGINS: `${URLS.web},http://localhost:${PORTS.web}`,
          RUSTFS_REGION: "auto",
        },
      },
    );
    await waitFor(`${endpoint}/health/ready`, "local object storage");
    await run("aws", ["s3api", "create-bucket", "--bucket", bucket, "--endpoint-url", endpoint, "--region", "auto"], { env: objectStorageCredentials() });
    await run(
      "aws",
      [
        "s3api",
        "put-bucket-cors",
        "--bucket",
        bucket,
        "--endpoint-url",
        endpoint,
        "--region",
        "auto",
        "--cors-configuration",
        JSON.stringify({
          CORSRules: [
            {
              AllowedHeaders: ["*"],
              AllowedMethods: ["GET", "HEAD", "PUT"],
              AllowedOrigins: [URLS.web, `http://localhost:${PORTS.web}`],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: 3600,
            },
          ],
        }),
      ],
      { env: objectStorageCredentials() },
    );
    await run("aws", ["s3api", "head-bucket", "--bucket", bucket, "--endpoint-url", endpoint, "--region", "auto"], { env: objectStorageCredentials() });
    const smokeKey = `chalk-perf-smoke-${suffix}.txt`;
    const smokePath = join(runtimeRoot, `${containerName}-smoke.txt`);
    const smokeDownloadPath = join(runtimeRoot, `${containerName}-smoke-download.txt`);
    const smokeBody = "chalk local object storage probe\n";
    await writeFile(smokePath, smokeBody, { mode: 0o600 });
    try {
      await run("aws", ["s3api", "put-object", "--bucket", bucket, "--key", smokeKey, "--body", smokePath, "--endpoint-url", endpoint, "--region", "auto"], { env: objectStorageCredentials() });
      await run("aws", ["s3api", "get-object", "--bucket", bucket, "--key", smokeKey, "--endpoint-url", endpoint, "--region", "auto", smokeDownloadPath], { env: objectStorageCredentials() });
      const downloadedSmokeBody = await readFile(smokeDownloadPath, "utf8");
      if (downloadedSmokeBody !== smokeBody) {
        throw new Error("local object storage put/get verification returned different content");
      }
    } finally {
      await unlink(smokePath).catch(() => {});
      await unlink(smokeDownloadPath).catch(() => {});
    }
    log(`local object storage ready (${bucket} at ${endpoint})`);
    return objectStorage;
  } catch (error) {
    await stopObjectStorage();
    throw error;
  }
}

async function stopObjectStorage({ includeStoredState = true } = {}) {
  const candidate = objectStorage ?? (includeStoredState ? await loadObjectStorageState() : null);
  if (!candidate?.containerName || !candidate?.ownerLabel) return;

  const inspection = await run("docker", ["inspect", "--format", `{{index .Config.Labels "${OBJECT_STORAGE_OWNER_LABEL}"}}`, candidate.containerName], { tolerateFailure: true });
  const inspectionOutput = `${inspection.out}${inspection.err}`;
  if (inspection.code !== 0) {
    if (/no such (object|container)/i.test(inspectionOutput)) {
      const volumeRemoved = await removeOwnedObjectStorageVolume(candidate);
      if (!volumeRemoved) {
        objectStorage = null;
        return;
      }
      await unlink(OBJECT_STORAGE_STATE_PATH).catch(() => {});
      objectStorage = null;
    } else {
      log(`could not verify local object storage ownership for ${candidate.containerName}; leaving it running`);
    }
    return;
  }
  if (inspection.out.trim() !== candidate.ownerLabel) {
    log(`refusing to stop unowned object storage container ${candidate.containerName}`);
    return;
  }

  const removal = await run("docker", ["rm", "--force", candidate.containerName], { tolerateFailure: true });
  if (removal.code !== 0) {
    log(`could not stop local object storage ${candidate.containerName}; preserving ownership state`);
    return;
  }
  const volumeRemoved = await removeOwnedObjectStorageVolume(candidate);
  objectStorage = null;
  if (!volumeRemoved) return;
  await unlink(OBJECT_STORAGE_STATE_PATH).catch(() => {});
  log(`stopped local object storage ${candidate.containerName}`);
}

async function removeOwnedObjectStorageVolume(candidate) {
  if (!candidate.volumeName) return true;
  const inspection = await run("docker", ["volume", "inspect", "--format", `{{index .Labels "${OBJECT_STORAGE_OWNER_LABEL}"}}`, candidate.volumeName], { tolerateFailure: true });
  if (inspection.code !== 0) {
    if (!/no such (object|volume)/i.test(`${inspection.out}${inspection.err}`)) {
      log(`could not verify local object storage volume ownership for ${candidate.volumeName}; leaving it in place`);
      return false;
    }
    return true;
  }
  if (inspection.out.trim() !== candidate.ownerLabel) {
    log(`refusing to remove unowned object storage volume ${candidate.volumeName}`);
    return false;
  }
  const removal = await run("docker", ["volume", "rm", candidate.volumeName], { tolerateFailure: true });
  if (removal.code !== 0) {
    log(`could not remove local object storage volume ${candidate.volumeName}`);
    return false;
  }
  log(`removed local object storage volume ${candidate.volumeName}`);
  return true;
}

async function up() {
  await mkdir(runtimeRoot, { recursive: true });

  // 1. Backing resources (idempotent scripts own container lifecycle).
  // Keep profiler state isolated from the shared development database.
  await run("docker", ["start", "chalk-postgres"], { tolerateFailure: true });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await run("docker", ["exec", "chalk-postgres", "pg_isready", "-U", "postgres", "-d", "postgres"], { tolerateFailure: true });
    if (ready.code === 0) break;
    await sleep(500);
    if (attempt === 59) throw new Error("postgres container did not become ready");
  }
  const hasDb = await run("docker", ["exec", "chalk-postgres", "psql", "-U", "postgres", "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${DATABASE_NAME}'`]);
  if (!hasDb.out.trim()) {
    await run("docker", ["exec", "chalk-postgres", "psql", "-U", "postgres", "-d", "postgres", "-c", `CREATE DATABASE "${DATABASE_NAME}"`]);
  }
  log(`postgres ready (${DATABASE_NAME} present)`);
  await run("bash", ["apps/api/scripts/dev-redis.sh", "start"]);

  // 2. Migrations.
  await run("bash", ["apps/api/scripts/db-migrate.sh", "up"], { env: { CHALK_DATABASE_URL: DATABASE_URL } });

  // 3. Signing identity + mTLS material (mirrors scripts/dev/chalk-resources.mjs
  // prepareIdentity: ed25519 signing key + local CA and two leaf certificates).
  const { generateSigningIdentity, identityPaths, identityEnvironment } = await import(join(repoRoot, "scripts", "dev", "identity.mjs"));
  const paths = identityPaths({ runtimeRoot });
  const signing = await generateSigningIdentity({ paths });
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const serial = join(paths.root, "local-ca.srl");
  const apiExt = join(paths.root, "api.ext");
  const syncExt = join(paths.root, "sync.ext");
  await writeFile(apiExt, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
  await writeFile(syncExt, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:spiffe://chalk.local/environment/local/sync/00000000-0000-4000-8000-000000000000\n");
  async function makeLeaf(keyPath, outPath, subject, extFile, caCert, caKey, createSerial) {
    await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", `${outPath}.csr`, "-subj", subject]);
    await run("openssl", ["x509", "-req", "-in", `${outPath}.csr`, "-CA", caCert, "-CAkey", caKey, "-CAserial", serial, ...(createSerial ? ["-CAcreateserial"] : []), "-out", outPath, "-days", "2", "-sha256", "-extfile", extFile]);
    await unlink(`${outPath}.csr`).catch(() => {});
  }
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", paths.caKey, "-out", paths.caCertificate, "-subj", "/CN=chalk-local-ca", "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  await makeLeaf(paths.apiKey, paths.apiCertificate, "/CN=chalk-api-provider-bridge", apiExt, paths.caCertificate, paths.caKey, true);
  await makeLeaf(paths.syncKey, paths.syncCertificate, "/CN=chalk-sync-provider-bridge", syncExt, paths.caCertificate, paths.caKey, false);
  await Promise.all([paths.caKey, paths.apiKey, paths.syncKey].map((path) => chmod(path, 0o600)));
  log("identity material generated");

  // 4. SFU credentials from 1Password.
  const { createOpSecretResolver } = await import(join(repoRoot, "scripts", "dev", "secrets.mjs"));
  const provider = await createOpSecretResolver({ op: "op" })();
  log(`sfu credentials resolved from vault item`);

  const systemToken = randomBytes(32).toString("base64url");
  const idEnv = identityEnvironment({
    paths,
    privateKey: signing.rawPrivateKey,
    publicKeyring: signing.publicKeyring,
    issuer: "http://chalk.local",
    audience: "chalk-sync",
    kid: "local-dev",
    trustDomain: "chalk.local",
    providerBridgeAddress: "127.0.0.1:8444",
  });

  // 5. Isolated S3-compatible storage for chat attachment uploads.
  await startObjectStorage();
  const r2Env = {
    CHALK_R2_ACCESS_KEY_ID: objectStorage.accessKeyID,
    CHALK_R2_ACCOUNT_ID: "local",
    CHALK_R2_BUCKET: objectStorage.bucket,
    CHALK_R2_ENDPOINT: objectStorage.endpoint,
    CHALK_R2_SECRET_ACCESS_KEY: objectStorage.secretAccessKey,
    CHALK_R2_REQUEST_TIMEOUT_MS: "10000",
  };

  // 6. API (Go) — includes the provider bridge listener.
  spawnService("api", "go", ["run", "./cmd"], {
    cwd: join(repoRoot, "apps", "api"),
    logFile: join(runtimeRoot, "api.log"),
    env: {
      CHALK_API_ADDR: `127.0.0.1:${PORTS.api}`,
      CHALK_API_ENV: "local",
      CHALK_API_LOCAL_SYSTEM_TOKEN: systemToken,
      CHALK_API_CORS_ALLOWED_ORIGINS: URLS.web,
      CHALK_DATABASE_URL: DATABASE_URL,
      CHALK_REDIS_URL: `redis://127.0.0.1:${PORTS.redis}/0`,
      CHALK_CLOUDFLARE_REALTIME_APP_ID: provider.appId,
      CHALK_CLOUDFLARE_REALTIME_APP_SECRET: provider.appSecret,
      ...r2Env,
      ...idEnv,
    },
  });
  await waitFor(`${URLS.api}/readyz`, "api");

  // 7. Verify the real Cloudflare SFU path once.
  await run("go", ["run", "./cmd/dev-sfu-probe"], {
    cwd: join(repoRoot, "apps", "api"),
    env: { CHALK_CLOUDFLARE_REALTIME_APP_ID: provider.appId, CHALK_CLOUDFLARE_REALTIME_APP_SECRET: provider.appSecret },
  });
  log("sfu probe verified");

  // 8. Sync (Elixir).
  spawnService("sync", "mix", ["run", "--no-halt"], {
    cwd: join(repoRoot, "apps", "sync"),
    logFile: join(runtimeRoot, "sync.log"),
    env: {
      MIX_ENV: "prod",
      CHALK_SYNC_PORT: String(PORTS.sync),
      CHALK_SYNC_BIND_IP: "127.0.0.1",
      CHALK_SYNC_LOCAL_PARITY: "true",
      CHALK_DATABASE_URL: DATABASE_URL,
      CHALK_SYNC_MAX_WAL_LAG_BYTES: "0",
      ...idEnv,
    },
  });
  await waitFor(`http://127.0.0.1:${PORTS.sync}/readyz`, "sync");

  // 9. Web (Vite dev server).
  spawnService("web", "pnpm", ["--filter", "web", "exec", "vite", "dev", "--host", "127.0.0.1", "--port", String(PORTS.web)], {
    cwd: repoRoot,
    logFile: join(runtimeRoot, "web.log"),
    env: {
      CHALK_DEV_WEB_PORT: String(PORTS.web),
      CHALK_DEV_API_ORIGIN: URLS.api,
      VITE_API_URL: URLS.api,
      VITE_CHALK_DEV_SYNC_URL: URLS.sync,
      // Public Space flow reads VITE_CHALK_SYNC_URL (chalk-access.ts publicSyncURL);
      // the supervised stack predates this variable and misses it.
      VITE_CHALK_SYNC_URL: URLS.sync,
      VITE_CHALK_DEV_MEDIA_PLANE: "cf_sfu",
    },
  });
  await waitFor(`${URLS.web}/`, "web");

  const manifestPath = join(runtimeRoot, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        status: "ready",
        urls: URLS,
        ports: PORTS,
        manifestPath,
        objectStorage: { bucket: objectStorage.bucket, endpoint: objectStorage.endpoint, containerName: objectStorage.containerName },
      },
      null,
      2,
    ),
  );
  log(`ready; manifest at ${manifestPath}`);
  log(`join URL for the harness: ${URLS.web}/space?name=<name>`);
}

async function down({ includeStoredObjectStorage = true } = {}) {
  stopping = true;
  for (const [name, child] of [...children]) {
    log(`stopping ${name}`);
    child.kill("SIGTERM");
  }
  await Promise.allSettled([...children].map(([, child]) => new Promise((resolve) => child.on("exit", resolve))));
  children.clear();
  await stopObjectStorage({ includeStoredState: includeStoredObjectStorage });
}

const command = process.argv[2] ?? "--up";
if (command === "--up") {
  try {
    await up();
    process.on("SIGINT", async () => {
      await down();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await down();
      process.exit(0);
    });
    setInterval(() => {}, 60_000); // keep the supervisor alive
  } catch (error) {
    await down({ includeStoredObjectStorage: false }).catch((cleanupError) => log(`cleanup after startup failure failed: ${cleanupError.message}`));
    throw error;
  }
} else if (command === "--down") {
  // Kill leftovers from a previous run by port owner name is handled manually;
  // this only stops services this script spawned in this process.
  await down();
} else {
  console.error("usage: node dev-stack.mjs [--up|--down]");
  process.exit(2);
}
