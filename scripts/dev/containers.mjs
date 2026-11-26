import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";

export function containerNames(config) {
  const id = createHash("sha256").update(config.root).digest("hex").slice(0, 12);
  return { network: `chalk-dev-${id}`, api: `chalk-dev-${id}-api`, sync: `chalk-dev-${id}-sync`, sfu: `chalk-dev-${id}-sfu`, cache: `chalk-dev-${id}` };
}

export function containerPath(config, path) {
  const inside = relative(config.root, path);
  if (inside.startsWith(`..${sep}`) || inside === "..") throw new Error(`Container path is outside the checkout: ${path}`);
  return `/workspace/${inside.split(sep).join("/")}`;
}

export async function toolchainVersions(root) {
  const tools = await readFile(`${root}/.tool-versions`, "utf8");
  const go = await readFile(`${root}/apps/api/go.mod`, "utf8");
  const versions = {
    go: go.match(/^go (\S+)$/m)?.[1],
    erlang: tools.match(/^erlang (\S+)$/m)?.[1],
    elixir: tools.match(/^elixir ([\d.]+)-otp-28$/m)?.[1],
  };
  if (Object.values(versions).some((value) => !value)) throw new Error("Cannot read the pinned Go, Erlang and Elixir versions");
  return versions;
}

export function imageName(service, versions) {
  return service === "api" ? `chalk-dev-api:go-${versions.go}` : `chalk-dev-sync:elixir-${versions.elixir}-otp-${versions.erlang}`;
}

export function containerArguments(config, service, { image, env = {}, command, interactive = false, platform = process.platform } = {}) {
  const names = containerNames(config);
  const args = ["run", "--rm", "--init", ...(interactive ? ["-it"] : []), "--network", names.network, ...(platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []), "--mount", `type=bind,source=${config.root},target=/workspace`, "--workdir", `/workspace/apps/${service}`];
  if (!command) {
    args.push("--name", names[service], "--network-alias", service);
    const ports = service === "api" ? [config.ports.api, config.ports.providerBridge] : [config.ports.sync];
    for (const port of ports) args.push("--publish", `127.0.0.1:${port}:${port}`);
    if (service === "api") args.push("--mount", `type=bind,source=${config.runtimeRoot}/dashboard-artifacts,target=/dashboard-artifacts`);
  }
  const mounts =
    service === "api"
      ? [
          ["go-mod", "/cache/go-mod"],
          ["go-build", "/cache/go-build"],
        ]
      : [
          ["mix-deps", "/workspace/apps/sync/deps"],
          ["mix-build", "/workspace/apps/sync/_build"],
        ];
  for (const [name, target] of mounts) args.push("--mount", `type=volume,source=${names.cache}-${name},target=${target}`);
  for (const key of Object.keys(env)) args.push("--env", key);
  args.push(image, ...(command || (service === "api" ? ["sh", "-c", "set -e; /workspace/scripts/dev/start-api-container.sh"] : ["mix", "run", "--no-halt"])));
  return args;
}

export function containerEnvironment(config, service, env) {
  const result = { ...env, CHALK_DATABASE_URL: `postgres://postgres:postgres@postgres:5432/${config.databaseName}?sslmode=disable` };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string" && value.startsWith(config.root)) result[key] = containerPath(config, value);
  }
  if (service === "api") {
    if (result.CHALK_R2_BUCKET === "local-dashboard") {
      result.CHALK_R2_INTERNAL_ENDPOINT = `http://127.0.0.1:${config.ports.web}/__local-dashboard-artifacts`;
      result.CHALK_DEV_ARTIFACT_PORT = String(config.ports.web);
    }
    result.CHALK_PRESENTING_RENDERER_ENDPOINT ||= "http://127.0.0.1:8093/invoke";
    result.CHALK_API_ADDR = `0.0.0.0:${config.ports.api}`;
    result.CHALK_PROVIDER_BRIDGE_ADDRESS = `0.0.0.0:${config.ports.providerBridge}`;
    result.CHALK_REDIS_URL = `redis://${config.redis.container}:6379/0`;
  } else {
    result.CHALK_SYNC_LOCAL_CONTAINER = "true";
    result.CHALK_SYNC_BIND_IP = "0.0.0.0";
    result.CHALK_SYNC_PROVIDER_BRIDGE_URL = `https://api:${config.ports.providerBridge}`;
  }
  return result;
}

export async function prepareImages(config, run) {
  const versions = await toolchainVersions(config.root);
  for (const service of ["api", "sync"]) {
    const buildArgs = service === "api" ? ["--build-arg", `GO_VERSION=${versions.go}`] : ["--build-arg", `ERLANG_VERSION=${versions.erlang}`, "--build-arg", `ELIXIR_VERSION=${versions.elixir}`];
    await run("docker", ["build", ...buildArgs, "--tag", imageName(service, versions), "--file", `${config.root}/scripts/dev/containers/${service}.Dockerfile`, `${config.root}/scripts/dev/containers`]);
  }
  return versions;
}
