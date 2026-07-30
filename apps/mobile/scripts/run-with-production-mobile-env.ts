import { existsSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCTION_BROKER_URL = "https://chalkmeet.com/local-chalk";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileDir = dirname(scriptDir);
const localEnvPath = join(mobileDir, ".env.local");
const backupEnvPath = join(mobileDir, ".env.local.release-backup");

const command = process.argv.slice(2);
const normalizedCommand = command.filter((part, index) => !(part === "--" && index === 0));
while (normalizedCommand[0] === "--") {
  normalizedCommand.shift();
}

if (normalizedCommand.length === 0) {
  throw new Error("Usage: pnpm exec tsx ./scripts/run-with-production-mobile-env.ts -- <command> [args...]");
}

const hadLocalEnv = existsSync(localEnvPath);

let exitCode = 1;

try {
  if (hadLocalEnv) {
    renameSync(localEnvPath, backupEnvPath);
  }

  const [cmd, ...args] = normalizedCommand;
  if (!cmd) {
    throw new Error("Missing command for production mobile build wrapper");
  }

  const result = spawnSync(cmd, args, {
    cwd: mobileDir,
    stdio: "inherit",
    env: {
      ...process.env,
      EXPO_PUBLIC_CHALK_BROKER_URL: PRODUCTION_BROKER_URL,
      CHALK_APP_VARIANT: "production",
      NODE_ENV: "production",
    },
  });

  if (result.error) {
    throw result.error;
  }

  exitCode = result.status ?? 1;
} finally {
  if (hadLocalEnv && existsSync(backupEnvPath)) {
    renameSync(backupEnvPath, localEnvPath);
  }
}

process.exit(exitCode);
