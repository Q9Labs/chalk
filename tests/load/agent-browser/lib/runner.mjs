import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { parseConsoleSignals, parseErrorsSignals, parseEvalOutput, parseResourceSignals } from "./parsers.mjs";

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

export async function runAttempt({ attempt, workerId, options, outDir, runLabel, session: providedSession }) {
  const attemptId = String(attempt).padStart(4, "0");
  const attemptDir = resolve(outDir, `attempt-${attemptId}`);
  const session = providedSession ?? `chalk-join-stress-${runLabel}-w${workerId}-a${attemptId}`;
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
    roomSlug: null,
    browserSessionId: null,
    correlation: null,
    consoleSignals: null,
    errorSignals: null,
    resourceSignals: null,
    failureReason: null,
    failureDetail: null,
    artifactsDir: attemptDir,
  };

  try {
    if (!options.reuseSessionPerWorker) {
      await runAgent(session, ["close"], options, { tolerateFailure: true });
    }

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
    const shouldCaptureDetailed = shouldCaptureDetailedArtifacts(record, options);
    const urlRes = await runAgent(session, ["get", "url"], options, { tolerateFailure: true });
    const consoleRes = await runAgent(session, ["console", "--json"], options, { tolerateFailure: true });
    const parsedConsoleSignals = parseConsoleSignals(consoleRes.stdout);
    record.roomUrl = (urlRes.stdout ?? "").trim() || record.pollState?.url || null;
    record.roomSlug = extractRoomSlug(record.roomUrl) ?? extractRoomSlug(record.pollState?.url ?? null);
    record.browserSessionId = firstNonEmpty(parsedConsoleSignals?.chalk?.["room.join"]?.sessionId, parsedConsoleSignals?.chalk?.["api.request"]?.sessionId, parsedConsoleSignals?.chalk?.["websocket.connect"]?.sessionId, null);
    record.correlation = buildCorrelation(record, parsedConsoleSignals);

    if (shouldCaptureDetailed) {
      const [snapRes, errorsRes, resourcesRes] = await Promise.all([
        runAgent(session, ["snapshot", "-i"], options, { tolerateFailure: true }),
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
      record.consoleSignals = parsedConsoleSignals;
      record.errorSignals = parseErrorsSignals(errorsRes.stdout);
      record.resourceSignals = parseResourceSignals(resourcesRes.value ?? []);

      await Promise.all([
        writeFile(resolve(attemptDir, "url.txt"), urlRes.stdout ?? "", "utf8"),
        writeFile(resolve(attemptDir, "snapshot-final.txt"), snapRes.stdout ?? "", "utf8"),
        writeFile(resolve(attemptDir, "console.json"), consoleRes.stdout ?? "", "utf8"),
        writeFile(resolve(attemptDir, "errors.json"), errorsRes.stdout ?? "", "utf8"),
        writeFile(resolve(attemptDir, "resources.json"), JSON.stringify(resourcesRes.value ?? [], null, 2) + "\n", "utf8"),
      ]);
    } else {
      record.consoleSignals = null;
      record.errorSignals = null;
      record.resourceSignals = null;
      await writeFile(
        resolve(attemptDir, "lightweight.json"),
        JSON.stringify(
          {
            attempt: record.attempt,
            status: record.status,
            roomUrl: record.roomUrl,
            roomSlug: record.roomSlug,
            createToPrejoinMs: record.createToPrejoinMs,
            askToJoinToJoinedMs: record.askToJoinToJoinedMs,
            failureReason: record.failureReason,
            correlation: record.correlation,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    }

    if (record.status === "failed" && !record.failureReason) {
      record.failureReason = deriveFailureReason(record);
    }

    if (!options.keepSessions && !options.reuseSessionPerWorker) {
      await runAgent(session, ["close"], options, { tolerateFailure: true });
    }
    record.finishedAt = new Date().toISOString();
    if (record.correlation) {
      record.correlation.finishedAt = record.finishedAt;
    }
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

function shouldCaptureDetailedArtifacts(record, options) {
  if (options.artifactMode === "all") return true;
  if (options.artifactMode === "none") return record.status === "failed";
  if (record.status === "failed") return true;
  if (!options.successSamplePercent) return false;
  return Math.random() * 100 < options.successSamplePercent;
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

function buildCorrelation(record, consoleSignals) {
  const api = consoleSignals?.chalk?.["api.request"] ?? null;
  const roomJoin = consoleSignals?.chalk?.["room.join"] ?? null;
  const ws = consoleSignals?.chalk?.["websocket.connect"] ?? null;

  const traceId = firstNonEmpty(api?.traceId, null);
  const requestId = firstNonEmpty(api?.requestId, null);
  const cfRay = firstNonEmpty(api?.cfRay, null);
  const inputRoomSlug = firstNonEmpty(roomJoin?.inputRoomSlug, null);
  const apiPath = firstNonEmpty(api?.requestPath, null);
  const apiRoomSlug = extractRoomSlugFromRequestPath(apiPath);

  return {
    attempt: record.attempt,
    workerId: record.workerId,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    agentBrowserSessionId: record.session,
    browserSessionId: firstNonEmpty(roomJoin?.sessionId, api?.sessionId, ws?.sessionId, null),
    roomUrl: record.roomUrl,
    roomSlug: firstNonEmpty(record.roomSlug, inputRoomSlug, apiRoomSlug, null),
    roomId: firstNonEmpty(roomJoin?.roomId, null),
    participantId: firstNonEmpty(roomJoin?.participantId, null),
    apiRequestPath: apiPath,
    apiStatusCode: api?.statusCode ?? null,
    requestId,
    traceId,
    cfRay,
  };
}

function extractRoomSlug(urlText) {
  if (!urlText) return null;
  try {
    const parsed = new URL(urlText);
    const match = parsed.pathname.match(/\/room\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractRoomSlugFromRequestPath(path) {
  if (!path) return null;
  const match = String(path).match(/\/rooms\/([^/]+)\/participants$/);
  return match?.[1] ?? null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function closeSession(session, options) {
  await runAgent(session, ["close"], options, { tolerateFailure: true });
}
