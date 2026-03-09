#!/usr/bin/env bun

import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseEvalOutput } from "./lib/parsers.mjs";

const defaults = {
  baseUrl: "https://chalk.q9labs.ai",
  commandTimeoutMs: 45000,
  browserDefaultTimeoutMs: 25000,
  waitAfterJoinClickMs: 10000,
  postJoinOfflineMs: 75000,
  rtkAbortWaitMs: 90000,
  scenarios: ["prejoin_offline", "join_api_abort", "post_join_offline", "rtk_route_abort"],
};

const options = parseArgs(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(options.outDir ?? `tests/results/agent-browser-chaos/${stamp}`);
await mkdir(outDir, { recursive: true });
await requireAgentBrowser();

const records = [];
for (const scenario of options.scenarios) {
  const startedAt = Date.now();
  const session = `chalk-chaos-${stamp}-${scenario}`;
  const dir = resolve(outDir, scenario);
  await mkdir(dir, { recursive: true });
  await runAgent(session, ["close"], options, { tolerateFailure: true });

  try {
    let result;
    if (scenario === "prejoin_offline") result = await runPrejoinOffline({ session, dir, options });
    else if (scenario === "join_api_abort") result = await runJoinApiAbort({ session, dir, options });
    else if (scenario === "post_join_offline") result = await runPostJoinOffline({ session, dir, options });
    else if (scenario === "rtk_route_abort") result = await runRtkRouteAbort({ session, dir, options });
    else throw new Error(`Unknown scenario: ${scenario}`);

    records.push({
      scenario,
      status: result.status,
      durationMs: Date.now() - startedAt,
      supportCode: result.supportCode ?? null,
      details: result.details,
      artifactDir: dir,
    });
  } catch (error) {
    records.push({
      scenario,
      status: "fail",
      durationMs: Date.now() - startedAt,
      supportCode: null,
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
      artifactDir: dir,
    });
  } finally {
    await runAgent(session, ["set", "offline", "off"], options, { tolerateFailure: true });
    await runAgent(session, ["close"], options, { tolerateFailure: true });
  }
}

const summary = {
  startedAt: new Date().toISOString(),
  baseUrl: options.baseUrl,
  outDir,
  scenarios: records.length,
  passed: records.filter((r) => r.status === "pass").length,
  warned: records.filter((r) => r.status === "warn").length,
  failed: records.filter((r) => r.status === "fail").length,
  records,
};

const report = [
  "# Agent Browser Chaos Repro Report",
  "",
  `- Base URL: ${options.baseUrl}`,
  `- Scenarios: ${summary.scenarios}`,
  `- Passed: ${summary.passed}`,
  `- Warned: ${summary.warned}`,
  `- Failed: ${summary.failed}`,
  "",
  "## Scenario Results",
  "",
  ...records.map((r) => `- ${r.scenario}: ${r.status} (${r.durationMs}ms) support=${r.supportCode ?? "-"}`),
  "",
].join("\n");

await writeFile(resolve(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
await writeFile(resolve(outDir, "report.md"), report, "utf8");
await writeFile(resolve(outDir, "records.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

console.log(`[chaos] outDir=${outDir}`);
for (const record of records) {
  console.log(`[chaos] ${record.status} scenario=${record.scenario} support=${record.supportCode ?? "-"} durationMs=${record.durationMs}`);
}

async function runPrejoinOffline({ session, dir, options }) {
  await openPrejoin(session, options);
  await runAgent(session, ["set", "offline", "on"], options);
  await clickAskToJoin(session, options);
  await delay(options.waitAfterJoinClickMs);
  const capture = await captureScenario(session, dir, options);
  const hasModal = /(Connection Timed Out|Something went wrong|Authentication Issue)/i.test(capture.bodyText);
  const hasSupport = Boolean(capture.supportCode);
  const hasRoomJoinError = capture.consoleSignals.roomJoinOutcome === "error";
  return {
    status: hasSupport && hasModal && hasRoomJoinError ? "pass" : "fail",
    supportCode: capture.supportCode,
    details: { hasModal, hasSupport, hasRoomJoinError, roomJoinErrorCode: capture.consoleSignals.roomJoinErrorCode },
  };
}

async function runJoinApiAbort({ session, dir, options }) {
  await openPrejoin(session, options);
  await runAgent(session, ["network", "route", "https://chalk-api.q9labs.ai/api/v1/rooms/*/participants", "--abort"], options);
  await runAgent(session, ["network", "route", `${options.baseUrl}/api/v1/rooms/*/participants`, "--abort"], options, { tolerateFailure: true });
  await clickAskToJoin(session, options);
  await delay(options.waitAfterJoinClickMs);
  const capture = await captureScenario(session, dir, options);
  const hasSupport = Boolean(capture.supportCode);
  const apiParticipantsError = capture.consoleSignals.apiRequestPath?.includes("/participants") && capture.consoleSignals.apiOutcome === "error";
  return {
    status: hasSupport && apiParticipantsError ? "pass" : "fail",
    supportCode: capture.supportCode,
    details: { hasSupport, apiParticipantsError, apiRequestPath: capture.consoleSignals.apiRequestPath, apiErrorCode: capture.consoleSignals.apiErrorCode },
  };
}

async function runPostJoinOffline({ session, dir, options }) {
  await openPrejoin(session, options);
  await clickAskToJoin(session, options);
  const joined = await waitForJoined(session, options, 60000);
  if (!joined) throw new Error("post_join_offline: join did not complete before offline test");
  await runAgent(session, ["set", "offline", "on"], options);
  await delay(options.postJoinOfflineMs);
  const capture = await captureScenario(session, dir, options);
  const hasConnectionOverlay = /Connection Failed|Unable to connect to the server/i.test(capture.bodyText);
  const hasReconnectingOverlay = /Connecting.*Connection lost\. Reconnecting|Connection lost\. Reconnecting/i.test(capture.bodyText);
  const hasEndScreen = /Meeting ended|Thanks for using Chalk/i.test(capture.bodyText);
  const hasDisconnectSignal = capture.consoleSignals.netErrCount > 0 || capture.consoleSignals.wsErrors > 0;
  return {
    status: hasDisconnectSignal && (hasConnectionOverlay || hasReconnectingOverlay || hasEndScreen) ? "pass" : "fail",
    supportCode: capture.supportCode,
    details: { hasConnectionOverlay, hasReconnectingOverlay, hasEndScreen, hasDisconnectSignal, netErrCount: capture.consoleSignals.netErrCount, wsErrors: capture.consoleSignals.wsErrors },
  };
}

async function runRtkRouteAbort({ session, dir, options }) {
  await openPrejoin(session, options);
  await runAgent(session, ["network", "route", "https://api.dyte.io/*", "--abort"], options);
  await runAgent(session, ["network", "route", "https://api-silos.dyte.io/*", "--abort"], options);
  await runAgent(session, ["network", "route", "https://location.dyte.io/*", "--abort"], options);
  await runAgent(session, ["network", "route", "https://flags.dyte.io/*", "--abort"], options);
  await runAgent(session, ["network", "route", "https://da-collector.dyte.io/*", "--abort"], options);
  await clickAskToJoin(session, options);
  await delay(options.rtkAbortWaitMs);
  const capture = await captureScenario(session, dir, options);
  const timeoutSheet = /Connection Timed Out/i.test(capture.bodyText);
  const hasSupport = Boolean(capture.supportCode);
  const joinedStill = /Share Screen|Meeting On Chalk|Leave/i.test(capture.bodyText);
  return {
    status: timeoutSheet && hasSupport ? "pass" : joinedStill ? "warn" : "fail",
    supportCode: capture.supportCode,
    details: { timeoutSheet, hasSupport, joinedStill, roomJoinOutcome: capture.consoleSignals.roomJoinOutcome, rtkJoinOutcome: capture.consoleSignals.rtkJoinAttemptOutcome },
  };
}

async function openPrejoin(session, options) {
  await runAgent(session, ["open", options.baseUrl], options);
  await runAgent(session, ["wait", "--load", "networkidle"], options);
  await clickButton(session, /start meeting/i, options, "Start Meeting");
  await runAgent(session, ["wait", "--load", "networkidle"], options);
}

async function clickAskToJoin(session, options) {
  await clickButton(session, /ask to join/i, options, "Ask to join");
}

async function clickButton(session, regex, options, label) {
  const deadline = Date.now() + 15000;
  let lastSample = [];
  while (Date.now() < deadline) {
    const evalRes = await evalJson(
      session,
      `(() => {
        const buttons = [...document.querySelectorAll("button")];
        const btn = buttons.find((b) => ${regex}.test((b.textContent || "").trim()));
        if (!btn) return { ok: false, sample: buttons.map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 20) };
        btn.click();
        return { ok: true, text: (btn.textContent || "").trim() };
      })()`,
      options,
      { tolerateFailure: true },
    );
    if (evalRes.ok && evalRes.value?.ok) {
      return;
    }
    lastSample = Array.isArray(evalRes?.value?.sample) ? evalRes.value.sample : lastSample;
    await delay(750);
  }
  throw new Error(`${label} button missing; sample=${JSON.stringify(lastSample)}`);
}

async function waitForJoined(session, options, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const poll = await evalJson(
      session,
      `(() => {
        const buttons = [...document.querySelectorAll("button")];
        const byText = (re) => buttons.some((b) => re.test((b.textContent || "").trim()));
        const hasLeave = Boolean(document.querySelector('button[aria-label*="Leave"]')) || byText(/^Leave$/i);
        const hasShare = Boolean(document.querySelector('button[aria-label*="Share Screen"]')) || byText(/Share Screen/i);
        return { hasLeave, hasShare };
      })()`,
      options,
      { tolerateFailure: true },
    );
    if (poll.ok && poll.value?.hasLeave && poll.value?.hasShare) return true;
    await delay(1250);
  }
  return false;
}

async function captureScenario(session, dir, options) {
  const [snapshot, body, screenshot, consoleRes, errors] = await Promise.all([
    runAgent(session, ["snapshot", "-i"], options, { tolerateFailure: true }),
    runAgent(session, ["get", "text", "body"], options, { tolerateFailure: true }),
    runAgent(session, ["screenshot", resolve(dir, "final.png")], options, { tolerateFailure: true }),
    runAgent(session, ["console", "--json"], options, { tolerateFailure: true }),
    runAgent(session, ["errors", "--json"], options, { tolerateFailure: true }),
  ]);
  await writeFile(resolve(dir, "snapshot.txt"), snapshot.stdout ?? "", "utf8");
  await writeFile(resolve(dir, "body.txt"), body.stdout ?? "", "utf8");
  await writeFile(resolve(dir, "console.json"), consoleRes.stdout ?? "", "utf8");
  await writeFile(resolve(dir, "errors.json"), errors.stdout ?? "", "utf8");
  await writeFile(resolve(dir, "screenshot.meta.txt"), screenshot.stdout ?? "", "utf8");
  const bodyText = body.stdout ?? "";
  return {
    bodyText,
    supportCode: bodyText.match(/CHK-\d{8}-\d{6}-[A-Z0-9]{3}/)?.[0] ?? null,
    consoleSignals: parseConsoleSignals(consoleRes.stdout ?? ""),
  };
}

function parseConsoleSignals(raw) {
  const parsed = safeJsonParse(raw);
  const messages = parsed?.data?.messages ?? [];
  const chalkEvents = messages.map((msg) => parseChalkEvent(msg?.text ?? "")).filter(Boolean);
  const roomJoinEvents = chalkEvents.filter((e) => e.eventType === "room.join");
  const apiEvents = chalkEvents.filter((e) => e.eventType === "api.request");
  const rtkAttemptEvents = chalkEvents.filter((e) => e.eventType === "room.join.rtk.attempt");
  return {
    roomJoinOutcome: roomJoinEvents.at(-1)?.outcome ?? null,
    roomJoinErrorCode: roomJoinEvents.at(-1)?.error?.code ?? null,
    apiOutcome: apiEvents.at(-1)?.outcome ?? null,
    apiRequestPath: apiEvents.at(-1)?.data?.request?.path ?? null,
    apiErrorCode: apiEvents.at(-1)?.error?.code ?? null,
    rtkJoinAttemptOutcome: rtkAttemptEvents.at(-1)?.outcome ?? null,
    netErrCount: messages.filter((m) => String(m?.text ?? "").includes("net::ERR_")).length,
    wsErrors: messages.filter((m) => /websocket|MAX_RECONNECT_ATTEMPTS/i.test(String(m?.text ?? ""))).length,
  };
}

function parseChalkEvent(text) {
  if (!text.startsWith("[Chalk]")) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  return safeJsonParse(text.slice(start));
}

async function evalJson(session, js, options, runOptions = {}) {
  const res = await runAgent(session, ["eval", js], options, runOptions);
  return parseEvalOutput(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
}

async function requireAgentBrowser() {
  const res = await runAgent("chalk-chaos-probe", ["--version"], { ...defaults, commandTimeoutMs: 10000, browserDefaultTimeoutMs: 10000 }, { noSession: true, tolerateFailure: true });
  if (res.code !== 0) {
    throw new Error("agent-browser not found. Install with: npm install -g agent-browser && agent-browser install");
  }
}

function runAgent(session, args, options, runOptions = {}) {
  const commandArgs = runOptions.noSession ? args : ["--session", session, ...args];
  const timeoutMs = runOptions.timeoutMs ?? options.commandTimeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("agent-browser", commandArgs, {
      env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: String(options.browserDefaultTimeoutMs) },
      cwd: process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr };
      if ((code ?? 1) !== 0 && !runOptions.tolerateFailure) {
        rejectPromise(new Error(`agent-browser ${commandArgs.join(" ")} failed: ${stderr || stdout}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

function parseArgs(argv) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") out.baseUrl = String(argv[++i]);
    else if (arg === "--out-dir") out.outDir = String(argv[++i]);
    else if (arg === "--scenarios")
      out.scenarios = String(argv[++i])
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === "--post-join-offline-ms") out.postJoinOfflineMs = Number(argv[++i]);
    else if (arg === "--rtk-abort-wait-ms") out.rtkAbortWaitMs = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun tests/load/agent-browser/chaos-repro.mjs [--base-url <url>] [--out-dir <path>] [--scenarios <comma-list>]");
      process.exit(0);
    } else throw new Error(`Unknown arg: ${arg}`);
  }
  return out;
}

function safeJsonParse(input) {
  if (!input || typeof input !== "string") return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
