import { existsSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROD_API_URL = "https://chalk-api.q9labs.ai";
const PROD_WS_URL = "wss://chalk-ws.q9labs.ai/ws";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileDir = dirname(scriptDir);
const localEnvPath = join(mobileDir, ".env.local");
const backupEnvPath = join(mobileDir, ".env.local.release-backup");
const verifyScriptPath = join(scriptDir, "verify-production-mobile-host-key.ts");

const command = process.argv.slice(2);

if (command.length === 0) {
  throw new Error("Usage: pnpm exec tsx ./scripts/run-with-production-mobile-env.ts -- <command> [args...]");
}

if (!process.env.EXPO_PUBLIC_CHALK_API_KEY?.trim()) {
  throw new Error("EXPO_PUBLIC_CHALK_API_KEY is required for production mobile builds");
}

const hadLocalEnv = existsSync(localEnvPath);

let exitCode = 1;

try {
  if (hadLocalEnv) {
    renameSync(localEnvPath, backupEnvPath);
  }

  const verifyResult = spawnSync("pnpm", ["exec", "tsx", verifyScriptPath], {
    cwd: mobileDir,
    stdio: "inherit",
    env: {
      ...process.env,
      EXPO_PUBLIC_API_URL: PROD_API_URL,
      EXPO_PUBLIC_WS_URL: PROD_WS_URL,
      CHALK_APP_VARIANT: "production",
      NODE_ENV: "production",
    },
  });

  if (verifyResult.error) {
    throw verifyResult.error;
  }

  if ((verifyResult.status ?? 1) !== 0) {
    exitCode = verifyResult.status ?? 1;
  } else {
    const [cmd, ...args] = command;
    if (!cmd) {
      throw new Error("Missing command for production mobile build wrapper");
    }

    const result = spawnSync(cmd, args, {
      cwd: mobileDir,
      stdio: "inherit",
      env: {
        ...process.env,
        EXPO_PUBLIC_API_URL: PROD_API_URL,
        EXPO_PUBLIC_WS_URL: PROD_WS_URL,
        CHALK_APP_VARIANT: "production",
        NODE_ENV: "production",
      },
    });

    if (result.error) {
      throw result.error;
    }

    exitCode = result.status ?? 1;
  }
} finally {
  if (hadLocalEnv && existsSync(backupEnvPath)) {
    renameSync(backupEnvPath, localEnvPath);
  }
}

process.exit(exitCode);
