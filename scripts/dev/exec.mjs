import { randomBytes } from "node:crypto";
import { containerArguments, containerEnvironment, containerNames, imageName, prepareImages } from "./containers.mjs";
import { runChecked } from "./chalk-resources.mjs";
import { spawnCommand, killTree } from "../lib/platform.mjs";

function testDatabaseEnvironment(databaseURL) {
  return Object.fromEntries(
    [
      "CHALK_DATABASE_URL",
      "CHALK_CHAT_ATTACHMENT_TEST_DATABASE_URL",
      "CHALK_PROVIDER_BRIDGE_E2E_DATABASE_URL",
      "CHALK_PUBLIC_INVITES_TEST_DATABASE_URL",
      "CHALK_SPACE_LIFECYCLE_TEST_DATABASE_URL",
      "CHALK_STATUS_TEST_DATABASE_URL",
      "CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL",
      "CHALK_SYNC_TEST_DATABASE_URL",
      "CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL",
      "CHALK_WEBHOOK_TEST_DATABASE_URL",
      "CHALK_WHITEBOARD_TEST_DATABASE_URL",
    ].map((key) => [key, databaseURL]),
  );
}

function testDatabaseURL(environment, temporaryDatabase) {
  const database = new URL(environment.CHALK_DATABASE_URL || `postgres://postgres:postgres@postgres:5432/${temporaryDatabase}?sslmode=disable`);
  if (database.pathname === "/chalk_dev") throw new Error("Tests must not target chalk_dev; set CHALK_DATABASE_URL to a separate test database");
  if (["localhost", "127.0.0.1"].includes(database.hostname)) {
    database.hostname = "postgres";
    database.port = "5432";
  }
  return database.toString();
}

export async function executeDevCommand(service, command, { config, environment = process.env, run = runChecked, spawn = spawnCommand, prepare = prepareImages, signals = process } = {}) {
  if (!["api", "sync"].includes(service) || !command.length) throw new Error("Usage: pnpm dev:exec api|sync <command> [args]");
  const versions = await prepare(config, run);
  const env = containerEnvironment(config, service, service === "sync" ? { MIX_ENV: "test" } : {});
  const temporaryDatabase = environment.CHALK_DATABASE_URL ? undefined : `chalk_test_${randomBytes(8).toString("hex")}`;
  const containerName = `chalk-test-${randomBytes(8).toString("hex")}`;
  Object.assign(env, testDatabaseEnvironment(testDatabaseURL(environment, temporaryDatabase)));
  let created = false;
  let interrupted;
  let child;
  let stopping;
  const interrupt = (signal) => {
    interrupted = signal;
    if (!child || stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = run("docker", ["stop", "--time", "3", containerName])
      .catch((error) => {
        if (!/No such container/i.test(error.cause?.stderr || error.message)) throw error;
      })
      .finally(() => killTree(child));
    // Await and propagate this failure from finally, after the child exits.
    void stopping.catch(() => {});
  };
  const onINT = () => interrupt("SIGINT");
  const onTERM = () => interrupt("SIGTERM");
  signals.on("SIGINT", onINT);
  signals.on("SIGTERM", onTERM);
  const signalCode = () => (interrupted === "SIGINT" ? 130 : 143);
  try {
    if (temporaryDatabase) {
      await run("docker", ["exec", config.postgres.container, "createdb", "-U", "postgres", temporaryDatabase]);
      created = true;
      if (interrupted) return signalCode();
      await run(process.execPath, ["apps/api/scripts/db-migrate.mjs", "--allow-missing", "up"], { cwd: config.root, env: { CHALK_DATABASE_URL: env.CHALK_DATABASE_URL, CHALK_DEV_NETWORK: containerNames(config).network } });
    }
    if (interrupted) return signalCode();
    const args = containerArguments(config, service, { image: imageName(service, versions), env, command, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
    args.splice(1, 0, "--name", containerName);
    child = spawn("docker", args, { env: { ...environment, ...env }, stdio: "inherit", detached: process.platform !== "win32" });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    return interrupted ? signalCode() : code;
  } catch (error) {
    if (interrupted) return signalCode();
    throw error;
  } finally {
    try {
      try {
        await stopping;
      } finally {
        if (created) await run("docker", ["exec", config.postgres.container, "dropdb", "--force", "-U", "postgres", temporaryDatabase]);
      }
    } finally {
      signals.off("SIGINT", onINT);
      signals.off("SIGTERM", onTERM);
    }
  }
}
