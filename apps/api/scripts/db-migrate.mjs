import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containerArguments, imageName, toolchainVersions } from "../../../scripts/dev/containers.mjs";
import { localService } from "../../../scripts/dev/local-service.mjs";
const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = process.argv.slice(2);
if (["help", "describe", "--help", "-h"].includes(args[0])) {
  console.log("node apps/api/scripts/db-migrate.mjs [goose-command] [args]. Uses CHALK_DATABASE_URL or the local Postgres URL. Runs goose in Docker.");
} else {
  const versions = await toolchainVersions(root);
  const config = { root };
  // Standalone migrations also work against a host database; Linux can use its host network.
  const network = process.env.CHALK_DEV_NETWORK || (process.platform === "linux" ? "host" : "bridge");
  const url = process.env.CHALK_DATABASE_URL || localService("postgres").url;
  const databaseURL = !process.env.CHALK_DEV_NETWORK && process.platform !== "linux" ? url.replace(/@(localhost|127\.0\.0\.1):/, "@host.docker.internal:") : url;
  const dockerArgs = containerArguments(config, "api", { image: imageName("api", versions), env: { CHALK_DATABASE_URL: databaseURL }, command: ["sh", "-c", 'exec go tool goose -dir db/migrations postgres "$CHALK_DATABASE_URL" "$@"', "goose", ...(args.length ? args : ["status"])] });
  dockerArgs[dockerArgs.indexOf("--network") + 1] = network;
  try {
    await run("docker", ["image", "inspect", imageName("api", versions)]);
  } catch {
    await run("docker", ["build", "--build-arg", `GO_VERSION=${versions.go}`, "--tag", imageName("api", versions), "--file", `${root}/scripts/dev/containers/api.Dockerfile`, `${root}/scripts/dev/containers`]);
  }
  try {
    const result = await run("docker", dockerArgs, { env: { ...process.env, CHALK_DATABASE_URL: databaseURL }, maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    process.stderr.write(error.stderr || "Migration failed\n");
    process.exitCode = 1;
  }
}
