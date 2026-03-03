import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  parseConsoleSignals,
  parseErrorsSignals,
  parseEvalOutput,
  parseResourceSignals,
} from "./parsers.mjs";

export async function requireAgentBrowser() {
  const probe = await new Promise((resolvePromise) => {
    const child = spawn("agent-browser", ["--version"], { cwd: process.cwd() });
    let output = "";
    child.stdout.on("data", (d) => {
      output += String(d);
    });
    child.on("close", (code) => resolvePromise({ code, output }));
  });
  if (probe.code !== 0) {
    throw new Error("agent-browser not found. Install with: npm install -g agent-browser && agent-browser install");
  }
}

export async function runAttempt({ attempt, workerId, options, outDir, runLabel }) {
  const attemptId = String(attempt).padStart(4, "0");
  const attemptDir = resolve(outDir, `attempt-${attemptId}`);
  const session = `chalk-join-stress-${runLabel}-w${workerId}-a${attemptId}`;
  await mkdir(attemptDir, { recursive: true });

  const record = {
    attempt,
    workerId,
    session,
    startedAt: new Date().toISOString(),
    status: "failed",
    stage: "init",
    createToPrejoinMs: null,
    askToJoinToJoinedMs: null,
    pollCount: 0,
    pollState: null,
    roomUrl: null,
    consoleSignals: null,
    errorSignals: null,
    resourceSignals: null,
    failureReason: null,
    failureDetail: null,
    artifactsDir: attemptDir,
  };

  try {
    await runAgent(session, ["close"], options, { tolerateFailure: true });

    record.stage = "open_home";
    await must(session, ["open", options.baseUrl], options, record);
    await must(session, ["wait", "--load", "networkidle"], options, record);

    record.stage = "click_start_meeting";
    const createStart = Date.now();
    const startClick = await evalJson(
      session,
      `(() => {
        const buttons = [...document.querySelectorAll("button")];
        const btn = buttons.find((b) => (b.textContent || "").trim() === "Start Meeting")
          || buttons.find((b) => /start meeting/i.test((b.textContent || "").trim()));
        if (!btn) {
          return { clicked: false, sample: buttons.map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 20) };
        }
        btn.click();
        return { clicked: true, text: (btn.textContent || "").trim() };
      })()`,
      options,
    );
    if (!startClick.ok || !startClick.value?.clicked) {
      throw stageError("click_start_meeting", "start_meeting_button_missing", JSON.stringify(startClick));
    }
    await must(session, ["wait", "--load", "networkidle"], options, record);
    record.createToPrejoinMs = Date.now() - createStart;

    record.stage = "prejoin_capture";
    const prejoinSnapshot = await runAgent(session, ["snapshot", "-i"], options, { tolerateFailure: true });
    await writeFile(resolve(attemptDir, "snapshot-prejoin.txt"), prejoinSnapshot.stdout ?? "", "utf8");
    await runAgent(session, ["console", "--clear"], options, { tolerateFailure: true });
    await runAgent(session, ["errors", "--clear"], options, { tolerateFailure: true });

    record.stage = "click_ask_to_join";
    const joinStart = Date.now();
    const joinClick = await evalJson(
      session,
      `(() => {
        const buttons = [...document.querySelectorAll("button")];
        const btn = buttons.find((b) => /ask to join/i.test((b.textContent || "").trim()));
        if (!btn) {
          return { clicked: false, sample: buttons.map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 20) };
        }
        btn.click();
        return { clicked: true, text: (btn.textContent || "").trim() };
      })()`,
      options,
    );
    if (!joinClick.ok || !joinClick.value?.clicked) {
      throw stageError("click_ask_to_join", "ask_to_join_button_missing", JSON.stringify(joinClick));
    }

    record.stage = "wait_joined";
    const poll = await pollJoined(session, options, options.joinTimeoutMs, options.pollIntervalMs);
    record.pollCount = poll.pollCount;
    record.pollState = poll.lastState;
    record.askToJoinToJoinedMs = Date.now() - joinStart;
    if (!poll.joined) {
      throw stageError("wait_joined", "join_timeout", JSON.stringify(poll.lastState));
    }

    record.status = "success";
    record.stage = "done";
  } catch (err) {
    const parsed = parseStageError(err);
    record.status = "failed";
    record.stage = parsed.stage;
    record.failureReason = parsed.reason;
    record.failureDetail = parsed.detail;
  } finally {
    const [urlRes, snapRes, consoleRes, errorsRes, resourcesRes] = await Promise.all([
      runAgent(session, ["get", "url"], options, { tolerateFailure: true }),
      runAgent(session, ["snapshot", "-i"], options, { tolerateFailure: true }),
      runAgent(session, ["console", "--json"], options, { tolerateFailure: true }),
      runAgent(session, ["errors", "--json"], options, { tolerateFailure: true }),
      evalJson(
        session,
        `(() => {
          const entries = performance.getEntriesByType("resource")
            .filter((r) => /participants|access-token|iceservers|dyte|recordings\\/start|chalk-api|flags\\.dyte/i.test(r.name))
            .slice(-120)
            .map((r) => ({
              name: r.name,
              startTime: r.startTime,
              duration: r.duration,
              initiatorType: r.initiatorType,
              nextHopProtocol: r.nextHopProtocol
            }));
          return entries;
        })()`,
        options,
        { tolerateFailure: true },
      ),
    ]);

    record.roomUrl = (urlRes.stdout ?? "").trim() || null;
    record.consoleSignals = parseConsoleSignals(consoleRes.stdout);
    record.errorSignals = parseErrorsSignals(errorsRes.stdout);
    record.resourceSignals = parseResourceSignals(resourcesRes.value ?? []);
    if (record.status === "failed" && !record.failureReason) {
      record.failureReason = deriveFailureReason(record);
    }

    await Promise.all([
      writeFile(resolve(attemptDir, "url.txt"), urlRes.stdout ?? "", "utf8"),
      writeFile(resolve(attemptDir, "snapshot-final.txt"), snapRes.stdout ?? "", "utf8"),
      writeFile(resolve(attemptDir, "console.json"), consoleRes.stdout ?? "", "utf8"),
      writeFile(resolve(attemptDir, "errors.json"), errorsRes.stdout ?? "", "utf8"),
      writeFile(resolve(attemptDir, "resources.json"), JSON.stringify(resourcesRes.value ?? [], null, 2) + "\n", "utf8"),
    ]);

    if (!options.keepSessions) {
      await runAgent(session, ["close"], options, { tolerateFailure: true });
    }
    record.finishedAt = new Date().toISOString();
  }

  return record;
}

async function pollJoined(session, options, timeoutMs, intervalMs) {
  const started = Date.now();
  let pollCount = 0;
  let lastState = null;

  while (Date.now() - started < timeoutMs) {
    pollCount += 1;
    const result = await evalJson(
      session,
      `(() => {
        const buttons = [...document.querySelectorAll("button")];
        const byText = (re) => buttons.some((b) => re.test((b.textContent || "").trim()));
        const hasLeave = Boolean(document.querySelector('button[aria-label*="Leave"]')) || byText(/^Leave$/i);
        const hasShare = Boolean(document.querySelector('button[aria-label*="Share Screen"]')) || byText(/Share Screen/i);
        const hasJoining = byText(/joining/i);
        const hasAsk = byText(/ask to join/i);
        return { hasLeave, hasShare, hasJoining, hasAsk, url: location.href };
      })()`,
      options,
      { tolerateFailure: true },
    );
    if (result.ok) {
      lastState = result.value;
      if (result.value?.hasLeave && result.value?.hasShare) {
        return { joined: true, pollCount, lastState };
      }
    }
    await delay(intervalMs);
  }
  return { joined: false, pollCount, lastState };
}

async function evalJson(session, js, options, runOpts = {}) {
  const response = await runAgent(session, ["eval", js], options, runOpts);
  const raw = `${response.stdout ?? ""}\n${response.stderr ?? ""}`;
  const parsed = parseEvalOutput(raw);
  return parsed.ok ? parsed : { ok: false, value: null, raw };
}

async function must(session, args, options, record) {
  const result = await runAgent(session, args, options);
  if (result.code !== 0) {
    throw stageError(record.stage, "agent_browser_command_failed", `${args.join(" ")}\n${result.stderr ?? ""}`);
  }
  return result;
}

function runAgent(session, args, options, opts = {}) {
  const commandArgs = [];
  if (options.headed) commandArgs.push("--headed");
  commandArgs.push("--session", session, ...args);
  const timeoutMs = opts.timeoutMs ?? options.commandTimeoutMs;

  return new Promise((resolvePromise) => {
    const child = spawn("agent-browser", commandArgs, {
      env: {
        ...process.env,
        AGENT_BROWSER_DEFAULT_TIMEOUT: String(options.browserDefaultTimeoutMs),
      },
      cwd: process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr, timedOut, args: commandArgs });
    });
  });
}

function deriveFailureReason(record) {
  if (record.failureReason) return record.failureReason;
  if (record.consoleSignals?.chalk?.["api.request"]?.outcome === "failure") return "api_request_failure";
  if ((record.consoleSignals?.corsCount ?? 0) > 0) return "cors_noise_present";
  if ((record.consoleSignals?.netErrCount ?? 0) > 0) return "network_resource_error";
  if (record.stage === "wait_joined") return "join_timeout";
  return "unknown_failure";
}

function stageError(stage, reason, detail) {
  return { __stageError: true, stage, reason, detail };
}

function parseStageError(err) {
  if (err?.__stageError) return { stage: err.stage, reason: err.reason, detail: err.detail };
  return {
    stage: "unknown",
    reason: "unexpected_exception",
    detail: String(err?.stack ?? err?.message ?? err),
  };
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
