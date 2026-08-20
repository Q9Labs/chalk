import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDevConfig } from "./config.mjs";
import { createChalkSupervisor, defaultServiceSpecs, discoverWebJoinPath } from "./chalk.mjs";

test("Chalk adapter wires the core DAG and bootstrap boundaries without logging secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-adapter-test-"));
  const config = resolveDevConfig({ root, cwd: root, home: root, requiredTools: [], allowBusyPorts: ["api", "sync", "web", "bff", "postgres", "redis", "grafana"] });
  config.webJoinPath = "/space";
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
    if (url.pathname.endsWith("/tenants")) return response(200, { tenants: [] });
    if (url.pathname.endsWith("/spaces")) return response(200, { spaces: [] });
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
    assert.match(output[0], /Chalk dev ready/);
    assert.doesNotMatch(output.join("\n"), /app-secret|private-key-value/);
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
    ports: { api: 8080, sync: 4100, web: 3070 },
    urls: { api: "http://127.0.0.1:8080", sync: "http://127.0.0.1:4100", web: "http://127.0.0.1:3070" },
    runtimeRoot: "/tmp/chalk-runtime",
  };
  const specs = defaultServiceSpecs(config);
  assert.deepEqual(
    specs.slice(0, 2).map((spec) => spec.id),
    ["api", "sync"],
  );
  const whiteboard = specs.find((spec) => spec.id === "sdk-whiteboard");
  const react = specs.find((spec) => spec.id === "sdk-react");
  const web = specs.find((spec) => spec.id === "web");
  assert.deepEqual(whiteboard.args, ["--filter", "@q9labsai/chalk-whiteboard", "dev"]);
  assert.equal(whiteboard.readiness.filePath, "/tmp/chalk/packages/whiteboard/dist/react/index.js");
  assert.deepEqual(react.dependsOn, ["sdk-whiteboard"]);
  assert.deepEqual(web.dependsOn, ["sync", "sdk-client", "sdk-react", "sdk-whiteboard"]);
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

test("local adapter discovery finds the public web join route", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-discovery-test-"));
  try {
    const routesDirectory = join(root, "apps", "web", "src", "routes");
    await mkdir(routesDirectory, { recursive: true });
    await writeFile(join(routesDirectory, "space.index.tsx"), 'import { SpacePage } from "../components/space/SpacePage";\nexport const Route = createFileRoute("/space/")({ component: SpacePage });\n');
    assert.equal(discoverWebJoinPath(root), "/space");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mobile service receives the configured web port", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-mobile-env-test-"));
  const config = resolveDevConfig({ root, cwd: root, home: root, profile: "mobile", requiredTools: [], allowBusyPorts: ["web"] });
  config.webJoinPath = "/space";
  await mkdir(join(root, "apps/mobile/scripts"), { recursive: true });
  await writeFile(join(root, "apps/mobile/scripts/prepare-local-bridge.mjs"), 'process.stdout.write(process.env.CHALK_DEV_WEB_PORT || "");\n');
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
    assert.equal(output[0], String(config.ports.web));
    assert.equal(childEnvironments.get("mobile").CHALK_DEV_WEB_PORT, String(config.ports.web));
    await supervisor.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web service receives the configured API origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-web-env-test-"));
  const config = resolveDevConfig({ root, cwd: root, home: root, requiredTools: [], allowBusyPorts: ["web"] });
  config.webJoinPath = "/space";
  let webEnvironment;
  const resources = {
    state: { identity: { signing: { kid: "local-dev", rawPrivateKey: "private", publicKeyring: { "local-dev": "public" } } } },
    async preflight() {},
    async start() {},
    async stop() {},
  };
  try {
    const supervisor = createChalkSupervisor(config, {
      output: () => {},
      adapters: { resources, resolveSecrets: async () => undefined, acquireLease: async () => ({ runtimeId: "web-test", release: async () => {} }) },
      serviceSpecs: [{ id: "web", command: "node" }],
      hooks: {
        startService: async (spec, context) => {
          webEnvironment = context.childEnv;
          return { id: spec.id, pid: process.pid + 1, exited: false, logPath: `${spec.id}.log` };
        },
        stopService: async () => {},
      },
    });
    await supervisor.start();
    assert.equal(webEnvironment.CHALK_DEV_API_ORIGIN, config.urls.api);
    await supervisor.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
