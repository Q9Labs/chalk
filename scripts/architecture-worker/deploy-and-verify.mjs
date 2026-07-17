import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyDeployment } from "./verify.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const credentialDirectory = path.join(repositoryRoot, ".private");
const credentialPath = process.env.CHALK_ATLAS_ACCESS_CODE_FILE || path.join(credentialDirectory, "architecture-worker-access-code");
const wranglerConfig = path.join(repositoryRoot, "infrastructure/architecture-worker/wrangler.jsonc");
const uptimeWranglerConfig = path.join(repositoryRoot, "infrastructure/uptime-worker/wrangler.toml");

async function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd: repositoryRoot, env: process.env, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        process.stderr.write(chunk);
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${arguments_.join(" ")} failed with exit code ${code}.`));
    });
  });
}

async function accessCode() {
  if (process.env.CHALK_ATLAS_ACCESS_CODE) return { code: process.env.CHALK_ATLAS_ACCESS_CODE, persistAfterVerification: true };
  try {
    return { code: (await readFile(credentialPath, "utf8")).trim(), persistAfterVerification: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const generated = randomBytes(18).toString("base64url");
  await mkdir(path.dirname(credentialPath), { recursive: true });
  await writeFile(credentialPath, `${generated}\n`, { mode: 0o600 });
  await chmod(credentialPath, 0o600);
  console.log(`Generated the atlas access code at ${path.relative(repositoryRoot, credentialPath)} (mode 0600).`);
  return { code: generated, persistAfterVerification: false };
}

async function persistAccessCode(code) {
  await mkdir(path.dirname(credentialPath), { recursive: true });
  await writeFile(credentialPath, `${code}\n`, { mode: 0o600 });
  await chmod(credentialPath, 0o600);
  console.log(`Persisted the verified atlas access code at ${path.relative(repositoryRoot, credentialPath)} (mode 0600).`);
}

const credential = await accessCode();
const { code } = credential;
if (code.length < 16) throw new Error("CHALK_ATLAS_ACCESS_CODE must contain at least 16 characters.");

await run(process.execPath, [path.join(scriptDirectory, "build.mjs")]);
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "chalk-atlas-deploy-"));
const secretsPath = path.join(temporaryDirectory, "secrets.json");
await writeFile(
  secretsPath,
  JSON.stringify({
    ATLAS_ACCESS_CODE_SHA256: createHash("sha256").update(code).digest("hex"),
    ATLAS_SESSION_SECRET: randomBytes(32).toString("base64url"),
  }),
  { mode: 0o600 },
);

try {
  const deployment = await run("pnpm", ["exec", "wrangler", "deploy", "--strict", "--config", wranglerConfig, "--secrets-file", secretsPath], { capture: true });
  const combinedOutput = `${deployment.stdout}\n${deployment.stderr}`;
  const deploymentUrl = process.env.CHALK_ATLAS_URL || combinedOutput.match(/https:\/\/[a-z\d.-]+\.workers\.dev\/?/i)?.[0];
  if (!deploymentUrl) throw new Error("Wrangler deployed the Worker but did not report a workers.dev URL. Set CHALK_ATLAS_URL and rerun verification.");
  const result = await verifyDeployment(deploymentUrl, code);
  if (credential.persistAfterVerification) await persistAccessCode(code);
  if (process.env.CHALK_ATLAS_SKIP_MONITOR_DEPLOY === "1") {
    console.warn("Uptime monitor deployment explicitly skipped; architecture.access_boundary is inactive.");
  } else {
    await run("pnpm", ["exec", "wrangler", "deploy", "--strict", "--keep-vars", "--config", uptimeWranglerConfig, "--var", `ATLAS_BASE_URL:${result.url}`]);
    console.log("Uptime monitor deployed: architecture.access_boundary");
  }
  console.log(`Deployment ready: ${result.url}`);
  console.log(`Access code source: ${path.relative(repositoryRoot, credentialPath)}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
