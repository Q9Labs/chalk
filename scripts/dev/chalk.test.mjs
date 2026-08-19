import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDevConfig } from "./config.mjs";
import { createChalkSupervisor, defaultServiceSpecs, discoverBrokerRuntime, discoverWebJoinPath } from "./chalk.mjs";

test("Chalk adapter wires the core DAG and bootstrap boundaries without logging secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-adapter-test-"));
  const config = resolveDevConfig({ root, cwd: root, home: root, requiredTools: [], allowBusyPorts: ["api", "sync", "web", "bff", "postgres", "redis", "grafana", "broker"] });
  config.brokerRuntime = { configName: "wrangler.toml", directory: root, spaceBindingName: "CHALK_SPACE_ID" };
  config.webJoinPath = "/local";
  const output = [];
  const stopped = [];
  let apiChildEnv;
  const resources = {
    state: {
      identity: {
        signing: {
          kid: "local-dev",
          rawPrivateKey: "private-key-value",
          publicKeyring: { "local-dev": "public-key-value" },
        },
      },
    },
    async preflight() {},
    async start() {},
    async stop() {
      stopped.push("resources");
    },
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/readyz")) return response(200, { status: "ready" });
    if (init.method === "POST" && url.pathname === "/v1/tenants") return response(201, { id: "tenant-1", name: "Chalk local dev runtime" });
    if (init.method === "POST" && url.pathname.endsWith("/spaces")) return response(201, { id: "space-1", slug: "chalk-local-runtime" });
    if (init.method === "POST" && url.pathname.endsWith("/api-keys")) return response(201, { api_key: { id: "key-1" }, secret: "broker-secret-value" });
    if (url.pathname.endsWith("/tenants")) return response(200, { tenants: [] });
    if (url.pathname.endsWith("/spaces")) return response(200, { spaces: [] });
    if (url.pathname.endsWith("/api-keys")) return response(200, { api_keys: [] });
    return response(404, {});
  };
  try {
    const supervisor = createChalkSupervisor(config, {
      output: (line) => output.push(line),
      adapters: {
        resources,
        resolveSecrets: async () => ({ appId: "app-id", appSecret: "app-secret" }),
        runner: async () => ({ stdout: '{"status":"ok","verified":true}' }),
        fetchImpl,
      },
      serviceSpecs: [{ id: "api", command: "node", readiness: { url: `${config.urls.api}/readyz` } }],
      hooks: {
        startService: async (spec, context) => {
          if (spec.id === "api") apiChildEnv = context.childEnv;
          return { id: spec.id, pid: process.pid + 1, exited: false, logPath: `${spec.id}.log` };
        },
        stopService: async (spec) => stopped.push(spec.id),
      },
    });
    const status = await supervisor.start();
    assert.equal(status.state, "ready");
    assert.equal(apiChildEnv.CHALK_API_REQUEST_LOGS, "all");
    assert.equal(apiChildEnv.CHALK_DEFAULT_MEDIA_PLANE, "cf_sfu");
    assert.match(output[0], /Chalk dev ready/);
    assert.doesNotMatch(output.join("\n"), /broker-secret-value|app-secret|private-key-value/);
    await supervisor.stop();
    assert.deepEqual(stopped, ["api", "resources"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default Chalk service graph keeps mobile optional and core dependencies ordered", () => {
  const config = {
    root: "/tmp/chalk",
    profile: "mobile",
    ports: { api: 8080, sync: 4100, web: 3070, broker: 8787 },
    urls: { api: "http://127.0.0.1:8080", sync: "http://127.0.0.1:4100", broker: "http://127.0.0.1:8787/local-chalk", web: "http://127.0.0.1:3070" },
    runtimeRoot: "/tmp/chalk-runtime",
    brokerRuntime: { configName: "wrangler.toml", directory: "/tmp/chalk/broker", spaceBindingName: "CHALK_SPACE_ID" },
  };
  const specs = defaultServiceSpecs(config);
  assert.deepEqual(
    specs.slice(0, 3).map((spec) => spec.id),
    ["api", "sync", "broker"],
  );
  const whiteboard = specs.find((spec) => spec.id === "sdk-whiteboard");
  const react = specs.find((spec) => spec.id === "sdk-react");
  const web = specs.find((spec) => spec.id === "web");
  const broker = specs.find((spec) => spec.id === "broker");
  assert.equal(broker.args.includes("wrangler.toml"), true);
  assert.equal(broker.args.includes("wrangler.local.toml"), false);
  assert.equal(broker.args.includes("--var"), true);
  assert.deepEqual(whiteboard.args, ["--filter", "@q9labsai/chalk-whiteboard", "dev"]);
  assert.equal(whiteboard.readiness.filePath, "/tmp/chalk/packages/whiteboard/dist/react/index.js");
  assert.deepEqual(react.dependsOn, ["sdk-whiteboard"]);
  assert.equal(web.dependsOn.includes("sdk-whiteboard"), true);
  assert.deepEqual(web.args, ["--filter", "web", "exec", "vite", "dev", "--host", "127.0.0.1", "--port", "3070"]);
  assert.equal(specs.at(-1).id, "mobile");
  assert.equal(specs.at(-1).optional, true);
  assert.deepEqual(specs.at(-1).dependsOn, ["web"]);
  assert.equal(specs.at(-1).readiness.url, "http://127.0.0.1:8081/status");
  assert.equal(specs.at(-1).readiness.bodyIncludes, "packager-status:running");
});

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

test("local adapter discovery finds the broker binding and web join route", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-discovery-test-"));
  try {
    const brokerDirectory = join(root, "infrastructure", "episode-broker");
    const legacyBrokerDirectory = join(root, "infrastructure", "legacy-broker");
    const routesDirectory = join(root, "apps", "web", "src", "routes");
    await mkdir(brokerDirectory, { recursive: true });
    await mkdir(legacyBrokerDirectory, { recursive: true });
    await mkdir(routesDirectory, { recursive: true });
    await writeFile(join(brokerDirectory, "wrangler.toml"), '[routes]\npattern = "chalk.local/local-chalk/*"\n[secrets]\nrequired = ["CHALK_API_KEY", "CHALK_SPACE_ID", "CHALK_TENANT_ID"]\n');
    await writeFile(join(legacyBrokerDirectory, "wrangler.toml"), '[routes]\npattern = "chalk.local/local-chalk/*"\n[secrets]\nrequired = ["CHALK_API_KEY", "CHALK_LEGACY_SPACE_ID", "CHALK_TENANT_ID"]\n');
    await writeFile(join(routesDirectory, "space.tsx"), 'import { Outlet, createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/space")({ component: Outlet });\n');
    assert.deepEqual(discoverBrokerRuntime(root), { configPath: join(brokerDirectory, "wrangler.toml"), configName: "wrangler.toml", directory: brokerDirectory, spaceBindingName: "CHALK_SPACE_ID" });
    assert.equal(discoverWebJoinPath(root), "/space");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mobile service receives the local broker URL and configured web port", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-mobile-env-test-"));
  const config = resolveDevConfig({ root, cwd: root, home: root, profile: "mobile", env: { CHALK_DEV_BROKER_PORT: "9876" }, requiredTools: [], allowBusyPorts: ["web", "broker"] });
  config.brokerRuntime = { configName: "wrangler.toml", directory: root, spaceBindingName: "CHALK_SPACE_ID" };
  config.webJoinPath = "/local";
  await mkdir(join(root, "apps/mobile/scripts"), { recursive: true });
  await writeFile(join(root, "apps/mobile/scripts/prepare-local-bridge.mjs"), 'process.stdout.write(process.env.CHALK_DEV_BROKER_PORT || "");\n');
  const output = [];
  const childEnvironments = new Map();
  const resources = {
    state: { identity: { signing: { kid: "local-dev", rawPrivateKey: "private", publicKeyring: { "local-dev": "public" } } } },
    async preflight() {},
    async start() {},
    async stop() {},
  };
  try {
    const supervisor = createChalkSupervisor(config, {
      output: (line) => output.push(line),
      adapters: { resources, resolveSecrets: async () => undefined, acquireLease: async () => ({ runtimeId: "mobile-test", release: async () => {} }) },
      serviceSpecs: [{ id: "mobile", command: "node" }],
      hooks: {
        startService: async (spec, context) => {
          childEnvironments.set(spec.id, context.childEnv);
          return { id: spec.id, pid: process.pid + 1, exited: false, logPath: `${spec.id}.log` };
        },
        stopService: async () => {},
      },
    });
    await supervisor.start();
    assert.equal(childEnvironments.get("mobile").EXPO_PUBLIC_CHALK_BROKER_URL, config.urls.broker);
    assert.equal(output[0], String(config.ports.broker));
    assert.equal(childEnvironments.get("mobile").CHALK_DEV_WEB_PORT, String(config.ports.web));
    await supervisor.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
