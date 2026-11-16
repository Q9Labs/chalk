import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveDevConfig } from "./config.mjs";
import { containerArguments, containerEnvironment, containerNames, imageName, prepareImages } from "./containers.mjs";
import { runChecked } from "./chalk-resources.mjs";
import { runCommand } from "../lib/platform.mjs";
const [service, ...command] = process.argv.slice(2);
if (!["api", "sync"].includes(service) || !command.length) throw new Error("Usage: pnpm dev:exec api|sync <command> [args]");
const config = resolveDevConfig({ root: fileURLToPath(new URL("../..", import.meta.url)) });
const versions = await prepareImages(config, runChecked);
const env = containerEnvironment(config, service, service === "sync" ? { MIX_ENV: "test" } : {});
const temporaryDatabase = process.env.CHALK_DATABASE_URL ? undefined : `chalk_test_${randomBytes(8).toString("hex")}`;
delete env.CHALK_DATABASE_URL;
if (process.env.CHALK_DATABASE_URL) {
  const database = new URL(process.env.CHALK_DATABASE_URL);
  if (database.pathname === "/chalk_dev") throw new Error("Tests must not target chalk_dev; set CHALK_DATABASE_URL to a separate test database");
  if (["localhost", "127.0.0.1"].includes(database.hostname)) {
    database.hostname = "postgres";
    database.port = "5432";
  }
  env.CHALK_DATABASE_URL = database.toString();
}
if (temporaryDatabase) {
  await runChecked("docker", ["exec", config.postgres.container, "createdb", "-U", "postgres", temporaryDatabase]);
  env.CHALK_DATABASE_URL = `postgres://postgres:postgres@postgres:5432/${temporaryDatabase}?sslmode=disable`;
}
env.CHALK_SYNC_TEST_DATABASE_URL = env.CHALK_DATABASE_URL;
try {
  if (temporaryDatabase) await runChecked(process.execPath, ["apps/api/scripts/db-migrate.mjs", "--allow-missing", "up"], { cwd: config.root, env: { CHALK_DATABASE_URL: env.CHALK_DATABASE_URL, CHALK_DEV_NETWORK: containerNames(config).network } });
  const args = containerArguments(config, service, { image: imageName(service, versions), env, command, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  process.exitCode = runCommand("docker", args, { env: { ...process.env, ...env } });
} finally {
  if (temporaryDatabase) await runChecked("docker", ["exec", config.postgres.container, "dropdb", "--force", "-U", "postgres", temporaryDatabase]);
}
