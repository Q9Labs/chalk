import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSupervisor } from "./supervisor.mjs";
import { createSecretResolver } from "./secrets.mjs";
import { identityEnvironment } from "./identity.mjs";
import { waitForFileReady, waitForHTTPReady } from "./process.mjs";
import { RuntimeState, FailureKind, failure } from "./model.mjs";
import { createResourceManager, runChecked } from "./chalk-resources.mjs";
import { bootstrapLocalSpace, retireLocalFixture } from "./chalk-bootstrap.mjs";
import { enableSeedInvite, proveSeededSignIn } from "./chalk-signin.mjs";
import { writeJsonAtomic } from "./ownership.mjs";

export function createChalkSupervisor(inputConfig, { adapters = {}, output = console.log, serviceSpecs, hooks = {} } = {}) {
  const config = {
    ...inputConfig,
    webJoinPath: inputConfig.webJoinPath || discoverWebJoinPath(inputConfig.root),
  };
  const selectedServiceSpecs = serviceSpecs || defaultServiceSpecs(config);
  const resources = adapters.resources || createResourceManager(config, adapters);
  let provider;
  let bindings;
  let systemToken;
  let invite;
  const resolver = config.secretResolver || adapters.resolveSecrets || createSecretResolver({ op: adapters.op || "op" });

  const mergedHooks = {
    ...hooks,
    revision:
      hooks.revision ||
      (async () => {
        try {
          return (await runChecked("git", ["rev-parse", "HEAD"], { cwd: config.root })).stdout.trim() || "unknown";
        } catch {
          return "unknown";
        }
      }),
    preflightOptions: { ...hooks.preflightOptions, which: adapters.which },
    resources: async () => [
      { kind: "container", name: config.postgres.container, reusable: true },
      { kind: "database", name: config.databaseName || "chalk_dev", container: config.postgres.container, reusable: true },
      { kind: "container", name: config.redis.container, reusable: true },
      { kind: "generated", path: config.runtimeRoot },
    ],
    resolveSecrets: async (context) => {
      provider = await resolver();
      if (provider?.source) await writeJsonAtomic(`${config.runtimeRoot}/sfu-source.json`, provider.source, { redacted: false });
      return provider;
    },
    startResources: async ({ lease }) => {
      systemToken = randomBytes(32).toString("base64url");
      await resources.start({ lease });
      if (!resources.state.identity?.signing) throw failure(FailureKind.STARTUP, "runtime signing identity was not generated", { stage: "identity" });
    },
    stopResources: async () => resources.stop(),
    beforeStartService: async (spec) => {
      if (spec.id === "sync") {
        // A fresh checkout has no Hex packages. Fetch and compile before the readiness clock starts for Sync.
        const cwd = `${config.root}/apps/sync`;
        const env = { MIX_ENV: "prod" };
        for (const args of [["local.hex", "--force", "--if-missing"], ["local.rebar", "--force", "--if-missing"], ["deps.get"], ["compile"]]) await runChecked("mix", args, { cwd, env });
        return;
      }
      if (spec.id !== "mobile") return;
      const bridgePath = `${config.root}/apps/mobile/scripts/prepare-local-bridge.mjs`;
      const result = await runChecked("node", [bridgePath], { cwd: config.root, env: { CHALK_DEV_WEB_PORT: String(config.ports.web) } });
      if (result.stdout?.trim()) output(result.stdout.trim());
      if (result.stderr?.trim()) output(result.stderr.trim());
    },
    logRedactions: async () => [provider?.appId, provider?.appSecret].filter(Boolean),
    childEnv: async (spec) => childEnvironment(spec.id),
    waitReady: async (spec, process, context) => {
      if (spec.readiness?.filePath) await waitForFileReady(spec, { timeoutMs: config.timeouts.readinessMs });
      else if (spec.readiness?.url) await waitForHTTPReady(spec, { timeoutMs: config.timeouts.readinessMs, fetchImpl: adapters.fetchImpl });
      if (spec.id === "api") {
        const runtimeId = context.runtime.runtimeId || "local";
        const stableMarker = stableFixtureMarker(config.root);
        if (config.fresh) await retireLocalFixture({ apiOrigin: config.urls.api, systemToken, runtimeId, marker: stableMarker, fetchImpl: adapters.fetchImpl });
        const fixtureMarker = stableMarker;
        bindings = await bootstrapLocalSpace({ apiOrigin: config.urls.api, systemToken, runtimeId, fixtureMarker, fetchImpl: adapters.fetchImpl, fresh: config.fresh });
        invite = await enableSeedInvite({ apiOrigin: config.urls.api, systemToken, tenantId: bindings.tenantId, spaceId: bindings.spaceId, fetchImpl: adapters.fetchImpl });
        // Holds the system token, so it stays in the git-ignored runtime directory with mode 0600 and out of evidence.
        await writeJsonAtomic(config.seedPath, { ...bindings, invite, systemToken, urls: config.urls, publicOrigin: config.publicOrigin }, { redacted: false });
      }
      // Ready means the seeded guest is admitted through the web origin, not that a port answers.
      if (spec.id === "web") await proveSeededSignIn({ origin: config.urls.web, invite, fetchImpl: adapters.fetchImpl });
    },
    onReady: async ({ runtime }) => {
      output(runtime.state === RuntimeState.DEGRADED ? formatDegradedSummary(config, runtime.status()) : formatReadySummary(config, bindings));
    },
  };
  const runtime = createSupervisor(config, { serviceSpecs: selectedServiceSpecs, hooks: mergedHooks, preflightFn: resources.preflight, acquireLease: adapters.acquireLease });
  runtime.commandHooks = {
    resetResources: async () => resources.reset?.(),
  };
  return runtime;

  function childEnvironment(serviceId) {
    const identity = resources.state.identity?.signing;
    const base = {
      CHALK_API_URL: config.urls.api,
      CHALK_DEV_API_ORIGIN: config.urls.api,
      CHALK_SYNC_URL: `ws://127.0.0.1:${config.ports.sync}/v1/sync`,
      CHALK_DEV_WEB_PORT: String(config.ports.web),
    };
    if (serviceId === "api") {
      if (!identity || !provider || !systemToken) throw failure(FailureKind.STARTUP, "API child identity is incomplete", { stage: "identity" });
      return {
        ...base,
        CHALK_API_ADDR: `127.0.0.1:${config.ports.api}`,
        CHALK_API_ENV: "local",
        CHALK_API_LOCAL_SYSTEM_TOKEN: systemToken,
        CHALK_API_REQUEST_LOGS: "all",
        CHALK_API_CORS_ALLOWED_ORIGINS: [...new Set([config.urls.web, config.urls.public])].join(","),
        CHALK_DATABASE_URL: databaseURL(config),
        CHALK_REDIS_URL: `redis://127.0.0.1:${config.redis.port}/0`,
        CHALK_CLOUDFLARE_REALTIME_APP_ID: provider.appId,
        CHALK_CLOUDFLARE_REALTIME_APP_SECRET: provider.appSecret,
        CHALK_SYNC_TOKEN_ISSUER: config.auth.issuer,
        CHALK_SYNC_TOKEN_AUDIENCE: config.auth.audience,
        CHALK_SYNC_TOKEN_KEY_ID: identity.kid,
        CHALK_SYNC_TOKEN_PRIVATE_KEY: identity.rawPrivateKey,
        CHALK_MEDIA_TOKEN_VERIFICATION_KEYS: JSON.stringify(identity.publicKeyring),
        ...identityEnvironment({
          paths: config.identity,
          privateKey: identity.rawPrivateKey,
          publicKeyring: identity.publicKeyring,
          issuer: config.auth.issuer,
          audience: config.auth.audience,
          kid: identity.kid,
          trustDomain: config.auth.trustDomain,
          providerBridgeAddress: `127.0.0.1:${config.ports.providerBridge}`,
        }),
      };
    }
    if (serviceId === "sync") {
      if (!identity) throw failure(FailureKind.STARTUP, "Sync child identity is incomplete", { stage: "identity" });
      return {
        ...base,
        MIX_ENV: "prod",
        CHALK_SYNC_PORT: String(config.ports.sync),
        CHALK_SYNC_BIND_IP: "127.0.0.1",
        CHALK_SYNC_LOCAL_PARITY: "true",
        CHALK_DATABASE_URL: databaseURL(config),
        CHALK_SYNC_TOKEN_ISSUER: config.auth.issuer,
        CHALK_SYNC_TOKEN_AUDIENCE: config.auth.audience,
        CHALK_SYNC_TOKEN_PUBLIC_KEYS: JSON.stringify(identity.publicKeyring),
        CHALK_SYNC_MAX_WAL_LAG_BYTES: "0",
        CHALK_SYNC_PROVIDER_BRIDGE_URL: `https://127.0.0.1:${config.ports.providerBridge}`,
        CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE: config.identity.syncCertificate,
        CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE: config.identity.syncKey,
        CHALK_SYNC_PROVIDER_BRIDGE_CAFILE: config.identity.caCertificate,
      };
    }
    if (serviceId === "web") {
      // A browser off this box dials Sync through the public origin, where Vite proxies /v1/sync to the local Sync port.
      const browserSync = config.publicOrigin ? `${config.publicOrigin.replace(/^http/, "ws")}/v1/sync` : base.CHALK_SYNC_URL;
      return { ...base, ...(config.publicOrigin ? { PUBLIC_ORIGIN: config.publicOrigin } : {}), CHALK_DEV_SYNC_ORIGIN: config.urls.sync, VITE_API_URL: config.urls.api, VITE_CHALK_SYNC_URL: browserSync, VITE_CHALK_DEV_SYNC_URL: browserSync, VITE_CHALK_DEV_MEDIA_PLANE: "cf_sfu" };
    }
    if (serviceId === "mobile") return { ...base, RCT_METRO_PORT: String(config.metro.port) };
    return {};
  }
}

function defaultServiceSpecs(config) {
  const specs = [
    { id: "api", command: "go", expectedCommand: null, args: ["run", "./cmd"], cwd: `${config.root}/apps/api`, readiness: { url: `${config.urls.api}/readyz` }, watchRoots: [`${config.root}/apps/api`] },
    { id: "sync", command: "mix", expectedCommand: null, args: ["run", "--no-halt"], cwd: `${config.root}/apps/sync`, dependsOn: ["api"], readiness: { url: `${config.urls.sync}/readyz` }, watchRoots: [`${config.root}/apps/sync`] },
    { id: "sdk-client", command: "pnpm", args: ["--filter", "@q9labsai/chalk-client", "dev"], cwd: config.root },
    { id: "sdk-whiteboard", command: "pnpm", args: ["--filter", "@q9labsai/chalk-whiteboard", "dev"], cwd: config.root, readiness: { filePath: join(config.root, "packages/whiteboard/dist/react/index.js") } },
    { id: "sdk-react", command: "pnpm", args: ["--filter", "@q9labsai/chalk-react", "dev"], cwd: config.root, dependsOn: ["sdk-whiteboard"] },
    { id: "web", command: "pnpm", args: ["--filter", "web", "exec", "vite", "dev", "--host", "127.0.0.1", "--port", String(config.ports.web)], cwd: config.root, dependsOn: ["sync", "sdk-client", "sdk-react", "sdk-whiteboard"], readiness: { url: `${config.urls.web}/` } },
  ];
  if (config.profile === "mobile")
    specs.push({
      id: "mobile",
      command: "pnpm",
      args: ["--filter", "@q9labsai/chalk-mobile", "run", "start:raw"],
      cwd: config.root,
      dependsOn: ["web"],
      readiness: { url: `http://127.0.0.1:${config.metro.port}/status`, bodyIncludes: "packager-status:running" },
      optional: true,
    });
  return specs;
}

function formatReadySummary(config, bindings) {
  return [
    "Chalk dev ready",
    `Web       ${config.urls.public}`,
    `API       ${config.urls.api}`,
    `Sync      ws://127.0.0.1:${config.ports.sync}/v1/sync`,
    "Media     Cloudflare SFU, real provider path",
    `Logs      ${config.aggregateLog}`,
    "Proof     pnpm dev:smoke",
    bindings ? `Runtime   ${bindings.marker}` : "",
    bindings ? `Space     ${bindings.spaceId} (Tenant ${bindings.tenantId}, media plane cf_sfu)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDegradedSummary(config, status) {
  const failures = Object.entries(status.optionalFailures || {}).map(([id, details]) => `${id}: ${details.message}${details.logPath ? ` (log: ${details.logPath})` : ""}`);
  return ["Chalk dev degraded", "Core services are not all ready.", ...failures, `Logs      ${config.aggregateLog}`].join("\n");
}

function databaseURL(config) {
  return `postgres://postgres:postgres@127.0.0.1:${config.ports.postgres}/${config.databaseName || "chalk_dev"}?sslmode=disable`;
}

function stableFixtureMarker(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

function discoverWebJoinPath(root) {
  const routesDirectory = join(root, "apps", "web", "src", "routes");
  const candidates = findFiles(routesDirectory)
    .filter(({ path, content }) => path.endsWith(".tsx") && (/from\s+["']@q9labsai\/chalk-react["']/.test(content) || /from\s+["'][^"']*\/components\/space\/SpacePage["']/.test(content)))
    .map(({ content }) => content.match(/createFileRoute\(\s*["']([^"']+)["']\s*\)/)?.[1])
    .filter((route) => route === "/_space");
  if (candidates.length !== 1) throw failure(FailureKind.CONFIG, `expected one public web join route, found ${candidates.length}`, { stage: "config" });
  return "/space";
}

function findFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "vendor"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findFiles(path);
    if (!entry.isFile()) return [];
    try {
      return [{ path, content: readFileSync(path, "utf8") }];
    } catch {
      return [];
    }
  });
}
