import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
export function localService(kind, env = process.env) {
  const postgres = kind === "postgres";
  const prefix = postgres ? "CHALK_POSTGRES" : "CHALK_REDIS";
  const name = env[`${prefix}_CONTAINER`] || `chalk-${kind}`;
  const volume = env[`${prefix}_VOLUME`] || `chalk-${kind}`;
  const port = env[`${prefix}_PORT`] || (postgres ? "5432" : "6379");
  const image = env[`${prefix}_IMAGE`] || (postgres ? "postgres:18.3-alpine" : "redis:8.10.0-alpine");
  const version = env[`${prefix}_EXPECTED_VERSION`] || (postgres ? "18.3" : "8.10.0");
  const user = env.CHALK_POSTGRES_USER || "postgres";
  const password = env.CHALK_POSTGRES_PASSWORD || "postgres";
  const database = env.CHALK_POSTGRES_DB || "chalk";
  const url = postgres ? `postgres://${user}:${password}@127.0.0.1:${port}/${database}?sslmode=disable` : `redis://127.0.0.1:${port}/0`;
  return { kind, name, volume, port, image, version, user, password, database, url };
}

export async function manageLocalService(kind, command = "start", { env = process.env, run = exec } = {}) {
  const service = localService(kind, env);
  const docker = async (args) => run("docker", args, { encoding: "utf8" });
  const exists = async () => {
    try {
      await docker(["container", "inspect", service.name]);
      return true;
    } catch (error) {
      if (error.code === 1) return false;
      throw error;
    }
  };
  if (command === "url") return service.url;
  if (["help", "describe", "--help", "-h"].includes(command)) return `Chalk local ${kind}: start | url | logs | stop | rm | wipe. Requires Docker Desktop, OrbStack or Docker Engine.`;
  if (command === "logs") return (await docker(["logs", service.name])).stdout;
  if (["stop", "rm", "wipe"].includes(command)) {
    if (await exists()) await docker(command === "stop" ? ["stop", service.name] : ["rm", "--force", service.name]);
    if (command === "wipe") {
      try {
        await docker(["volume", "inspect", service.volume]);
      } catch (error) {
        if (error.code === 1) return `${kind} removed`;
        throw error;
      }
      await docker(["volume", "rm", service.volume]);
    }
    return `${kind} ${command === "stop" ? "stopped" : "removed"}`;
  }
  if (command !== "start") throw new Error(`Unknown command: ${command}`);
  if (env.CHALK_REMOTE_RESOURCE_DIR) {
    await mkdir(env.CHALK_REMOTE_RESOURCE_DIR, { recursive: true });
    const temporary = join(env.CHALK_REMOTE_RESOURCE_DIR, `.${kind}-${randomUUID()}`);
    await writeFile(temporary, `${service.name}\n${service.volume}\n`);
    await rename(temporary, join(env.CHALK_REMOTE_RESOURCE_DIR, kind));
  }
  if (await exists()) await docker(["start", service.name]);
  else {
    const args = ["run", "--name", service.name, "--publish", `127.0.0.1:${service.port}:${kind === "postgres" ? 5432 : 6379}`, "--mount", `type=volume,source=${service.volume},target=${kind === "postgres" ? "/var/lib/postgresql" : "/data"}`];
    if (kind === "postgres") args.push("--env", `POSTGRES_DB=${service.database}`, "--env", `POSTGRES_USER=${service.user}`, "--env", `POSTGRES_PASSWORD=${service.password}`, "--env", "POSTGRES_INITDB_ARGS=--data-checksums");
    await docker([...args, "--detach", service.image]);
  }
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker(["exec", service.name, ...(kind === "postgres" ? ["pg_isready", "-h", "127.0.0.1", "-U", service.user, "-d", service.database] : ["redis-cli", "ping"])]);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error(`${kind} did not become ready. Run docker logs ${service.name}.`);
  const sql = (query) => docker(["exec", service.name, "psql", "-U", service.user, "-d", service.database, "-tAc", query]);
  const version = kind === "postgres" ? (await sql("show server_version")).stdout.trim() : (await docker(["exec", service.name, "redis-server", "--version"])).stdout.match(/v=([^\s]+)/)?.[1];
  if (!version?.startsWith(service.version)) throw new Error(`Expected ${kind} ${service.version}, got ${version}`);
  if (kind === "postgres" && (await sql("show data_checksums")).stdout.trim() !== "on") throw new Error("Existing Postgres volume has data checksums disabled. Wipe it explicitly; it will not be removed automatically.");
  return `${kind} ${version} ready\n${kind === "postgres" ? "CHALK_DATABASE_URL" : "CHALK_REDIS_URL"}=${service.url}`;
}
