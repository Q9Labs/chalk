import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(fixtureDirectory, "../..");
const requireFromClient = createRequire(join(repositoryDirectory, "sdks/typescript/client/package.json"));
const { chromium, firefox, webkit } = requireFromClient("playwright");
const arguments_ = new Set(process.argv.slice(2));
const browsersArgument = [...arguments_].find((argument) => argument.startsWith("--browsers="));
const requestedBrowsers = (browsersArgument?.split("=")[1] ?? "chromium,firefox,webkit").split(",").filter(Boolean);
const skipBuild = arguments_.has("--skip-build");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "chalk-sdk-web-consumer-"));
const archiveDirectory = join(temporaryDirectory, "archives");
const consumerDirectory = join(temporaryDirectory, "consumer");
const tenantAPIKey = `chalk_sk_fixture.${randomBytes(32).toString("base64url")}`;
const packedPackages = ["packages/assets", "packages/facehash", "packages/ui", "packages/whiteboard", "sdks/typescript/client", "sdks/typescript/react"];
let serverProcess;

try {
  await mkdir(archiveDirectory);
  await cp(join(fixtureDirectory, "consumer"), consumerDirectory, { recursive: true });
  if (!skipBuild) {
    for (const packageDirectory of packedPackages) await run("pnpm", ["--dir", packageDirectory, "run", "build"], repositoryDirectory);
  }
  for (const packageDirectory of packedPackages) await run("pnpm", ["pack", "--pack-destination", archiveDirectory], join(repositoryDirectory, packageDirectory));
  const archives = (await readdir(archiveDirectory)).filter((file) => file.endsWith(".tgz"));
  const clientArchive = requiredArchive(archives, "chalk-client");
  const reactArchive = requiredArchive(archives, "chalk-react");
  const supportingArchives = [requiredArchive(archives, "chalk-assets"), requiredArchive(archives, "facehash"), requiredArchive(archives, "chalk-ui"), requiredArchive(archives, "chalk-whiteboard")];

  await writeFile(join(consumerDirectory, "package.json"), `${JSON.stringify({ name: "chalk-packed-web-consumer", private: true, type: "module", packageManager: "pnpm@10.26.2" }, null, 2)}\n`);
  await writeFile(join(consumerDirectory, "pnpm-workspace.yaml"), workspacePolicy(archiveDirectory, { clientArchive, reactArchive, supportingArchives }));
  await run(
    "pnpm",
    [
      "add",
      "--save-exact",
      join(archiveDirectory, clientArchive),
      join(archiveDirectory, reactArchive),
      ...supportingArchives.map((archive) => join(archiveDirectory, archive)),
      "react@19.2.7",
      "react-dom@19.2.7",
      "@types/react@19.2.14",
      "@types/react-dom@19.2.3",
      "esbuild@0.28.1",
      "typescript@5.9.3",
      "ws@8.18.3",
    ],
    consumerDirectory,
  );
  await assertPackedInstall(consumerDirectory, clientArchive, reactArchive);
  await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], consumerDirectory);
  await run(process.execPath, ["build.mjs"], consumerDirectory);

  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: consumerDirectory,
    env: { ...process.env, CHALK_API_KEY: tenantAPIKey },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const baseURL = await listeningURL(serverProcess);
  for (const browserName of requestedBrowsers) {
    const browserType = { chromium, firefox, webkit }[browserName];
    if (!browserType) throw new TypeError(`Unknown browser: ${browserName}`);
    try {
      const executablePath = browserName === "chromium" ? process.env.CHALK_E2E_CHROMIUM_EXECUTABLE : undefined;
      const browser = await browserType.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      try {
        if (browserName === "chromium") await runChromiumMatrix(browser, baseURL, tenantAPIKey);
        else await runLaunchSmoke(browser, browserName, baseURL);
      } finally {
        await browser.close();
      }
      process.stdout.write(`[packed-e2e] ${browserName}: passed\n`);
    } catch (error) {
      if (!process.env.CI && browserUnavailable(error)) {
        process.stdout.write(`[packed-e2e] ${browserName}: skipped because its local Playwright binary is not installed\n`);
        continue;
      }
      throw error;
    }
  }
} finally {
  serverProcess?.kill("SIGTERM");
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function runChromiumMatrix(browser, baseURL, secretMarker) {
  const alice = await openParticipant(browser, baseURL, "alice");
  const bob = await openParticipant(browser, baseURL, "bob");
  try {
    await verifyPairJoined(alice.page, bob.page);
    await verifyScreenShare(alice.page, bob.page);
    await verifyRecovery(alice.page, bob.page, baseURL);
    await verifyRemovalAndLeave(alice.page, bob.page);
    await verifyDeniedAccess(browser, baseURL);
    await verifyServerState(baseURL, secretMarker);
  } finally {
    await Promise.all([alice.context.close(), bob.context.close()]);
  }
}

async function verifyPairJoined(alice, bob) {
  await Promise.all([invoke(alice, "join"), invoke(bob, "join")]);
  await Promise.all([waitForState(alice, "live"), waitForState(bob, "live")]);
  await Promise.all([
    waitFor(alice, (snapshot) => snapshot.participants.length === 2 && snapshot.remoteMedia.some((item) => item.participantSessionId === "bob" && item.source === "camera" && item.readyState === "live")),
    waitFor(bob, (snapshot) => snapshot.participants.length === 2 && snapshot.remoteMedia.some((item) => item.participantSessionId === "alice" && item.source === "camera" && item.readyState === "live")),
  ]);
}

async function verifyScreenShare(alice, bob) {
  await invoke(alice, "startScreenShare");
  await waitFor(bob, (snapshot) => snapshot.remoteMedia.some((item) => item.participantSessionId === "alice" && item.source === "screen" && item.readyState === "live"));
  await invoke(alice, "stopScreenShare");
  await waitFor(bob, (snapshot) => !snapshot.remoteMedia.some((item) => item.participantSessionId === "alice" && item.source === "screen"));
}

async function verifyRecovery(alice, bob, baseURL) {
  await Promise.all([waitForAccessRefresh(alice), waitForAccessRefresh(bob)]);
  await forceAndWaitForRecovery(alice, `${baseURL}/test/force-sync?participant=alice`);
  await forceAndWaitForRecovery(bob, `${baseURL}/test/force-media?participant=bob`);
}

async function forceAndWaitForRecovery(page, url) {
  await post(url);
  await waitFor(page, (snapshot) => snapshot.state === "reconnecting" || snapshot.state === "live");
  await waitForState(page, "live");
}

async function verifyRemovalAndLeave(alice, bob) {
  await invoke(alice, "removeParticipant", "bob");
  await waitFor(alice, (snapshot) => !snapshot.participants.includes("bob") && !snapshot.remoteMedia.some((item) => item.participantSessionId === "bob"));
  await Promise.all([invoke(alice, "leave"), invoke(bob, "leave")]);
  await Promise.all([waitForClean(alice), waitForClean(bob)]);
}

async function verifyDeniedAccess(browser, baseURL) {
  const denied = await openParticipant(browser, baseURL, "denied");
  try {
    const deniedCode = await denied.page.evaluate(tryDeniedJoin);
    if (deniedCode === "unexpected_success") throw new TypeError("Denied participant joined");
    await denied.page.waitForFunction(() => window.__chalk.snapshot().state === "failed" && Object.values(window.__chalk.resources()).every((count) => count === 0));
    await invoke(denied.page, "leave");
    await waitForClean(denied.page);
  } finally {
    await denied.context.close();
  }
}

async function tryDeniedJoin() {
  try {
    await window.__chalk.join();
    return "unexpected_success";
  } catch (error) {
    if (error instanceof Error && "code" in error) return error.code;
    return "rejected";
  }
}

async function verifyServerState(baseURL, secretMarker) {
  const [stateResponse, bundleResponse] = await Promise.all([fetch(`${baseURL}/test/state`), fetch(`${baseURL}/bundle.js`)]);
  const [stateText, bundleText] = await Promise.all([stateResponse.text(), bundleResponse.text()]);
  assertCredentialAbsent(stateText, bundleText, secretMarker);
  const state = JSON.parse(stateText);
  assertServerResourcesReleased(state, stateText);
  assertSyncRecovered(state);
  assertMediaRecovered(state);
  assertRefreshReasons(state, stateText);
}

function assertCredentialAbsent(stateText, bundleText, secretMarker) {
  if (stateText.includes(secretMarker) || bundleText.includes(secretMarker)) throw new TypeError("The backend credential entered a browser-readable response or bundle");
}

function assertServerResourcesReleased(state, stateText) {
  if (state.activeParticipants.length !== 0) throw new TypeError(`Server participants leaked after Leave: ${stateText}`);
  if (state.sockets.sync !== 0) throw new TypeError(`Server Sync sockets leaked after Leave: ${stateText}`);
  if (state.sockets.media !== 0) throw new TypeError(`Server media sockets leaked after Leave: ${stateText}`);
}

function assertSyncRecovered(state) {
  if (state.metrics.syncConnections < 3) throw new TypeError("Forced Sync recovery did not establish a replacement connection");
}

function assertMediaRecovered(state) {
  if (state.metrics.mediaReplacements < 1) throw new TypeError("Forced media recovery did not request replacement access");
  if (state.metrics.mediaConnections < 3) throw new TypeError("Forced media recovery did not establish replacement signaling");
}

function assertRefreshReasons(state, stateText) {
  if (!state.metrics.accessReasons.includes("scheduled_refresh")) throw new TypeError(`Scheduled access refresh was not observed: ${stateText}`);
  if (!state.metrics.accessReasons.includes("media_recovery")) throw new TypeError(`Media recovery access was not observed: ${stateText}`);
}

async function runLaunchSmoke(browser, browserName, baseURL) {
  const participant = await openParticipant(browser, baseURL, browserName);
  try {
    await invoke(participant.page, "join");
    await waitForState(participant.page, "live");
    await invoke(participant.page, "setCameraEnabled", false);
    await invoke(participant.page, "setCameraEnabled", true);
    await invoke(participant.page, "setMicrophoneEnabled", false);
    await invoke(participant.page, "setMicrophoneEnabled", true);
    await invoke(participant.page, "startScreenShare");
    await invoke(participant.page, "stopScreenShare");
    await invoke(participant.page, "leave");
    await waitForClean(participant.page);
  } finally {
    await participant.context.close();
  }
}

async function openParticipant(browser, baseURL, participant) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`${baseURL}/test/login?user=${participant}`);
  await page.waitForFunction(() => Boolean(window.__chalk));
  if (errors.length) throw errors[0];
  return { context, page };
}

function invoke(page, action, argument) {
  return page.evaluate(([name, value]) => window.__chalk[name](...(value === undefined ? [] : [value])), [action, argument]);
}

function waitForState(page, state) {
  return waitFor(page, (snapshot, expected) => snapshot.state === expected, state);
}

async function waitFor(page, predicate, argument) {
  await page.waitForFunction(([source, value]) => Function("snapshot", "value", `return (${source})(snapshot, value)`)(window.__chalk.snapshot(), value), [String(predicate), argument], { timeout: 10_000 });
}

async function waitForAccessRefresh(page) {
  await page.waitForFunction(() => window.__chalk.accessRequests() >= 2, null, { timeout: 5_000 });
}

async function waitForClean(page) {
  await page.waitForFunction(
    () => {
      const snapshot = window.__chalk.snapshot();
      const resources = window.__chalk.resources();
      return snapshot.state === "left" && Object.values(resources).every((count) => count === 0);
    },
    null,
    { timeout: 5_000 },
  );
}

async function post(url) {
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) throw new TypeError(`Fixture control request failed with HTTP ${response.status}: ${url}`);
}

async function assertPackedInstall(directory, clientArchive, reactArchive) {
  const packageJSON = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assertArchiveDependency(packageJSON, "@q9labsai/chalk-client", clientArchive);
  assertArchiveDependency(packageJSON, "@q9labsai/chalk-react", reactArchive);
  await run(process.execPath, ["-e", 'for (const name of ["@q9labsai/chalk-client", "@q9labsai/chalk-react"]) { const path = require.resolve(name); if (!path.includes("node_modules")) throw new Error(`${name} did not resolve from the clean install`); }'], directory);
}

function assertArchiveDependency(packageJSON, packageName, archive) {
  const specifier = packageJSON.dependencies?.[packageName];
  if (!String(specifier).includes(archive)) throw new TypeError(`The clean consumer did not record packed dependency ${packageName}`);
}

function requiredArchive(archives, name) {
  const archive = archives.find((file) => file.includes(name));
  if (!archive) throw new TypeError(`pnpm pack did not produce ${name}`);
  return archive;
}

function workspacePolicy(archiveDirectory_, archives) {
  const byPackage = {
    "@q9labsai/chalk-assets": archives.supportingArchives.find((archive) => archive.includes("chalk-assets")),
    "@q9labsai/facehash": archives.supportingArchives.find((archive) => archive.includes("facehash")),
    "@q9labsai/chalk-ui": archives.supportingArchives.find((archive) => archive.includes("chalk-ui")),
    "@q9labsai/chalk-whiteboard": archives.supportingArchives.find((archive) => archive.includes("chalk-whiteboard")),
    "@q9labsai/chalk-client": archives.clientArchive,
    "@q9labsai/chalk-react": archives.reactArchive,
  };
  const overrides = Object.entries(byPackage).map(([name, archive]) => `  "${name}": "file:${join(archiveDirectory_, archive)}"`);
  return [
    "packages:",
    '  - "."',
    "# Packed workspace dependencies must resolve to artifacts from this run, never to the registry.",
    "overrides:",
    ...overrides,
    "# esbuild needs its platform binary; the optional native msgpackr accelerator is unused by this browser fixture.",
    "allowBuilds:",
    "  esbuild: true",
    "  msgpackr-extract: false",
    "# This exact beta is pinned by the packed SDK; the exclusion only accommodates pnpm's machine-local no-downgrade trust policy.",
    "trustPolicyExclude:",
    '  - "effect@4.0.0-beta.94"',
    "",
  ].join("\n");
}

function browserUnavailable(error) {
  return error instanceof Error && /Executable doesn't exist|browserType\.launch: Executable/u.test(error.message);
}

function listeningURL(child) {
  return new Promise((resolveListening, reject) => {
    let buffer = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new TypeError(`Fixture server exited before listening with code ${code}`)));
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.type === "listening") resolveListening(message.url);
    });
  });
}

function run(command, arguments__, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, arguments__, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolveRun() : reject(new TypeError(`${command} ${arguments__.join(" ")} exited with code ${code}`))));
  });
}
