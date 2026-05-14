type MonitorSeverity = "critical" | "major"
type MonitorStatus = "healthy" | "failed"

type MonitorDefinition = {
  key: string
  url: string
  method: "GET" | "HEAD"
  severity: MonitorSeverity
  expectedStatusCodes: readonly number[]
}

type MonitorCheckResult = {
  runID: string
  resultKey: string
  monitor: MonitorDefinition
  status: MonitorStatus
  checkedAt: string
  latencyMs: number
  httpStatus?: number
  errorCode?: string
  errorMessage?: string
  responseExcerpt?: string
  attemptCount: number
}

type IngestPayload = {
  result_key: string
  run_id: string
  monitor_key: string
  status: MonitorStatus
  checked_at: string
  event_at: string
  latency_ms: number
  http_status?: number
  error_code?: string
  error_message?: string
  response_excerpt?: string
  reported_source: string
  reported_emitter_id: string
  metadata: Record<string, unknown>
  details: Record<string, unknown>
}

type IngestFailure = {
  result: MonitorCheckResult
  payload: IngestPayload
  attempts: number
  statusCode?: number
  errorCode: string
  errorMessage: string
}

type IngestAttempt =
  | {
      ok: true
      attempts: number
      statusCode: number
    }
  | {
      ok: false
      attempts: number
      statusCode?: number
      errorCode: string
      errorMessage: string
    }

type BufferedIngestRecord = {
  payload: IngestPayload
  buffered_at: string
  error_code: string
  error_message: string
  status_code?: number
}

type ReplaySummary = {
  attempted: number
  replayed: number
  failed: number
}

type TwilioAlertSummary = {
  attempted: boolean
  sent: boolean
  impairmentStreak: number
}

type RunSummary = {
  run_id: string
  checked_count: number
  healthy_count: number
  failed_count: number
  ingest_success_count: number
  ingest_failure_count: number
  replay_attempted: number
  replay_succeeded: number
  replay_failed: number
  buffered_count: number
  twilio_alert_attempted: boolean
  twilio_alert_sent: boolean
}

type CriticalIngestState = {
  streak: number
  last_alerted_streak: number
  updated_at: string
}

type RuntimeConfig = {
  ingestURL: string
  ingestToken: string
  checkTimeoutMs: number
  checkRetries: number
  ingestTimeoutMs: number
  ingestRetries: number
  retryBackoffMs: number
  maxParallelChecks: number
  runDeadlineMs: number
  replayBatchSize: number
  checkUserAgent: string
  reportedSource: string
  reportedEmitterID: string
  fallbackBufferPrefix: string
  twilioAlertThreshold: number
  twilioTimeoutMs: number
}

export interface Env {
  API_BASE_URL?: string
  CHALK_OPS_API_BASE_URL?: string
  OPS_INGEST_TOKEN?: string
  CHALK_OPS_INGEST_TOKEN?: string
  CHECK_TIMEOUT_MS?: string
  CHECK_RETRIES?: string
  INGEST_TIMEOUT_MS?: string
  INGEST_RETRIES?: string
  RETRY_BACKOFF_MS?: string
  MAX_PARALLEL_CHECKS?: string
  RUN_DEADLINE_MS?: string
  REPLAY_BATCH_SIZE?: string
  CHECK_USER_AGENT?: string
  REPORTED_SOURCE?: string
  REPORTED_EMITTER_ID?: string
  OPS_FALLBACK_BUFFER_PREFIX?: string
  TWILIO_ALERT_STREAK_THRESHOLD?: string
  TWILIO_TIMEOUT_MS?: string
  OPS_FALLBACK_BUFFER_BUCKET?: R2Bucket
  OPS_TWILIO_ACCOUNT_SID?: string
  OPS_TWILIO_AUTH_TOKEN?: string
  OPS_TWILIO_WHATSAPP_FROM?: string
  OPS_WHATSAPP_TO_CRITICAL?: string
}

const DEFAULT_MONITORS: readonly MonitorDefinition[] = [
  {
    key: "api.health",
    method: "GET",
    url: "https://chalk-api.q9labs.ai/health",
    severity: "critical",
    expectedStatusCodes: [200],
  },
  {
    key: "api.debug_ping",
    method: "HEAD",
    url: "https://chalk-api.q9labs.ai/api/v1/debug/ping",
    severity: "major",
    expectedStatusCodes: [200, 204],
  },
  {
    key: "web.home",
    method: "GET",
    url: "https://chalkmeet.com/",
    severity: "critical",
    expectedStatusCodes: [200],
  },
  {
    key: "web.status",
    method: "GET",
    url: "https://chalkmeet.com/status",
    severity: "major",
    expectedStatusCodes: [200],
  },
]

const DEFAULT_CHECK_TIMEOUT_MS = 4_000
const DEFAULT_CHECK_RETRIES = 1
const DEFAULT_INGEST_TIMEOUT_MS = 4_000
const DEFAULT_INGEST_RETRIES = 2
const DEFAULT_RETRY_BACKOFF_MS = 250
const DEFAULT_MAX_PARALLEL_CHECKS = 4
const DEFAULT_RUN_DEADLINE_MS = 25_000
const DEFAULT_REPLAY_BATCH_SIZE = 25
const DEFAULT_CHECK_USER_AGENT = "chalk-ops-monitor/1.0"
const DEFAULT_REPORTED_SOURCE = "cloudflare-ops-monitor"
const DEFAULT_REPORTED_EMITTER_ID = "chalk-ops-monitor"
const DEFAULT_FALLBACK_BUFFER_PREFIX = "ops-monitor"
const DEFAULT_TWILIO_ALERT_STREAK_THRESHOLD = 2
const DEFAULT_TWILIO_TIMEOUT_MS = 5_000

const BUFFER_PATH = "failed-ingest"
const STATE_PATH = "state/critical-ingest-streak.json"

let inMemoryCriticalIngestState: CriticalIngestState = {
  streak: 0,
  last_alerted_streak: 0,
  updated_at: new Date(0).toISOString(),
}

function parseNumberEnv(raw: string | undefined, fallback: number, min = 0): number {
  if (!raw) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) {
    return fallback
  }
  return Math.floor(value)
}

function normalizeBaseURL(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw
}

function buildRunID(scheduledAt: Date): string {
  return `cf-ops-monitor:${scheduledAt.toISOString()}:${crypto.randomUUID().slice(0, 8)}`
}

function buildResultKey(runID: string, monitorKey: string): string {
  return `${runID}:${monitorKey}`
}

function readRuntimeConfig(env: Env): RuntimeConfig {
  const apiBaseURL = env.API_BASE_URL || env.CHALK_OPS_API_BASE_URL
  if (!apiBaseURL) {
    throw new Error("missing required API_BASE_URL (or CHALK_OPS_API_BASE_URL)")
  }

  const ingestToken = env.OPS_INGEST_TOKEN || env.CHALK_OPS_INGEST_TOKEN
  if (!ingestToken) {
    throw new Error("missing required OPS_INGEST_TOKEN (or CHALK_OPS_INGEST_TOKEN)")
  }

  return {
    ingestURL: `${normalizeBaseURL(apiBaseURL)}/api/v1/ops/ingest/monitor-results`,
    ingestToken,
    checkTimeoutMs: parseNumberEnv(env.CHECK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS, 100),
    checkRetries: parseNumberEnv(env.CHECK_RETRIES, DEFAULT_CHECK_RETRIES, 0),
    ingestTimeoutMs: parseNumberEnv(env.INGEST_TIMEOUT_MS, DEFAULT_INGEST_TIMEOUT_MS, 100),
    ingestRetries: parseNumberEnv(env.INGEST_RETRIES, DEFAULT_INGEST_RETRIES, 0),
    retryBackoffMs: parseNumberEnv(env.RETRY_BACKOFF_MS, DEFAULT_RETRY_BACKOFF_MS, 0),
    maxParallelChecks: parseNumberEnv(env.MAX_PARALLEL_CHECKS, DEFAULT_MAX_PARALLEL_CHECKS, 1),
    runDeadlineMs: parseNumberEnv(env.RUN_DEADLINE_MS, DEFAULT_RUN_DEADLINE_MS, 1_000),
    replayBatchSize: parseNumberEnv(env.REPLAY_BATCH_SIZE, DEFAULT_REPLAY_BATCH_SIZE, 1),
    checkUserAgent: env.CHECK_USER_AGENT || DEFAULT_CHECK_USER_AGENT,
    reportedSource: env.REPORTED_SOURCE || DEFAULT_REPORTED_SOURCE,
    reportedEmitterID: env.REPORTED_EMITTER_ID || DEFAULT_REPORTED_EMITTER_ID,
    fallbackBufferPrefix: env.OPS_FALLBACK_BUFFER_PREFIX || DEFAULT_FALLBACK_BUFFER_PREFIX,
    twilioAlertThreshold: parseNumberEnv(
      env.TWILIO_ALERT_STREAK_THRESHOLD,
      DEFAULT_TWILIO_ALERT_STREAK_THRESHOLD,
      1,
    ),
    twilioTimeoutMs: parseNumberEnv(env.TWILIO_TIMEOUT_MS, DEFAULT_TWILIO_TIMEOUT_MS, 100),
  }
}

function remainingTime(deadlineAt: number): number {
  return deadlineAt - Date.now()
}

function boundedTimeout(timeoutMs: number, deadlineAt: number): number {
  const remaining = remainingTime(deadlineAt) - 25
  if (remaining <= 50) {
    return 0
  }
  return Math.max(50, Math.min(timeoutMs, remaining))
}

function shouldRetryStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort("timeout")
  }, timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readExcerpt(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text()
    const excerpt = text.trim().slice(0, 280)
    return excerpt.length > 0 ? excerpt : undefined
  } catch {
    return undefined
  }
}

function classifyFetchError(error: unknown): { code: string; message: string } {
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "timeout", message: "request timed out" }
  }
  return {
    code: "network_error",
    message: error instanceof Error ? error.message : String(error),
  }
}

async function executeMonitorCheck(
  monitor: MonitorDefinition,
  config: RuntimeConfig,
  runID: string,
  deadlineAt: number,
): Promise<MonitorCheckResult> {
  const attemptsTotal = config.checkRetries + 1

  for (let attempt = 1; attempt <= attemptsTotal; attempt += 1) {
    const timeoutMs = boundedTimeout(config.checkTimeoutMs, deadlineAt)
    if (timeoutMs === 0) {
      return {
        runID,
        resultKey: buildResultKey(runID, monitor.key),
        monitor,
        status: "failed",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        attemptCount: attempt,
        errorCode: "run_deadline_exceeded",
        errorMessage: "run deadline exceeded before check completed",
      }
    }

    const startedAt = Date.now()
    try {
      const response = await fetchWithTimeout(
        monitor.url,
        {
          method: monitor.method,
          headers: {
            "user-agent": config.checkUserAgent,
            "x-ops-monitor-run-id": runID,
          },
          redirect: "follow",
        },
        timeoutMs,
      )
      const latencyMs = Date.now() - startedAt
      const checkedAt = new Date().toISOString()
      const isHealthy = monitor.expectedStatusCodes.includes(response.status)

      if (isHealthy) {
        return {
          runID,
          resultKey: buildResultKey(runID, monitor.key),
          monitor,
          status: "healthy",
          checkedAt,
          latencyMs,
          httpStatus: response.status,
          attemptCount: attempt,
        }
      }

      const responseExcerpt = await readExcerpt(response)
      if (attempt < attemptsTotal) {
        await sleep(config.retryBackoffMs * attempt)
        continue
      }

      return {
        runID,
        resultKey: buildResultKey(runID, monitor.key),
        monitor,
        status: "failed",
        checkedAt,
        latencyMs,
        httpStatus: response.status,
        attemptCount: attempt,
        errorCode: "unexpected_status",
        errorMessage: `unexpected status code ${response.status}`,
        responseExcerpt,
      }
    } catch (error) {
      const latencyMs = Date.now() - startedAt
      if (attempt < attemptsTotal) {
        await sleep(config.retryBackoffMs * attempt)
        continue
      }

      const classified = classifyFetchError(error)
      return {
        runID,
        resultKey: buildResultKey(runID, monitor.key),
        monitor,
        status: "failed",
        checkedAt: new Date().toISOString(),
        latencyMs,
        attemptCount: attempt,
        errorCode: classified.code,
        errorMessage: classified.message,
      }
    }
  }

  return {
    runID,
    resultKey: buildResultKey(runID, monitor.key),
    monitor,
    status: "failed",
    checkedAt: new Date().toISOString(),
    latencyMs: 0,
    attemptCount: 1,
    errorCode: "unreachable_state",
    errorMessage: "unexpected check state",
  }
}

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  const out = new Array<TResult>(items.length)
  let index = 0

  async function worker(): Promise<void> {
    while (true) {
      const current = index
      index += 1
      if (current >= items.length) {
        return
      }
      out[current] = await mapper(items[current] as T)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return out
}

function buildIngestPayload(result: MonitorCheckResult, config: RuntimeConfig): IngestPayload {
  const metadata: Record<string, unknown> = {
    target_url: result.monitor.url,
    method: result.monitor.method,
    severity: result.monitor.severity,
    attempt_count: result.attemptCount,
    run_id: result.runID,
  }
  if (result.responseExcerpt) {
    metadata.response_excerpt = result.responseExcerpt
  }

  return {
    result_key: result.resultKey,
    run_id: result.runID,
    monitor_key: result.monitor.key,
    status: result.status,
    checked_at: result.checkedAt,
    event_at: result.checkedAt,
    latency_ms: result.latencyMs,
    http_status: result.httpStatus,
    error_code: result.errorCode,
    error_message: result.errorMessage,
    response_excerpt: result.responseExcerpt,
    reported_source: config.reportedSource,
    reported_emitter_id: config.reportedEmitterID,
    metadata,
    details: metadata,
  }
}

async function postIngestPayload(
  payload: IngestPayload,
  config: RuntimeConfig,
  deadlineAt: number,
): Promise<IngestAttempt> {
  const body = JSON.stringify(payload)
  const attemptsTotal = config.ingestRetries + 1

  for (let attempt = 1; attempt <= attemptsTotal; attempt += 1) {
    const timeoutMs = boundedTimeout(config.ingestTimeoutMs, deadlineAt)
    if (timeoutMs === 0) {
      return {
        ok: false,
        attempts: attempt,
        errorCode: "run_deadline_exceeded",
        errorMessage: "run deadline exceeded before ingest completed",
      }
    }

    try {
      const response = await fetchWithTimeout(
        config.ingestURL,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Ops-Ingest-Token": config.ingestToken,
          },
          body,
        },
        timeoutMs,
      )

      if (response.ok) {
        return {
          ok: true,
          attempts: attempt,
          statusCode: response.status,
        }
      }

      const responseExcerpt = await readExcerpt(response)
      const errorCode = `ingest_http_${response.status}`
      const errorMessage = responseExcerpt ? `ingest failed: ${responseExcerpt}` : `ingest failed with status ${response.status}`

      if (!shouldRetryStatus(response.status) || attempt >= attemptsTotal) {
        return {
          ok: false,
          attempts: attempt,
          statusCode: response.status,
          errorCode,
          errorMessage,
        }
      }
    } catch (error) {
      const classified = classifyFetchError(error)
      if (attempt >= attemptsTotal) {
        return {
          ok: false,
          attempts: attempt,
          errorCode: `ingest_${classified.code}`,
          errorMessage: classified.message,
        }
      }
    }

    await sleep(config.retryBackoffMs * attempt)
  }

  return {
    ok: false,
    attempts: attemptsTotal,
    errorCode: "ingest_unreachable_state",
    errorMessage: "unexpected ingest state",
  }
}

function buildBufferedObjectKey(config: RuntimeConfig, payload: IngestPayload): string {
  const encodedResultKey = encodeURIComponent(payload.result_key)
  return `${config.fallbackBufferPrefix}/${BUFFER_PATH}/${payload.monitor_key}/${encodedResultKey}.json`
}

async function bufferFailedIngest(
  env: Env,
  config: RuntimeConfig,
  payload: IngestPayload,
  ingestFailure: IngestAttempt & { ok: false },
): Promise<boolean> {
  const bucket = env.OPS_FALLBACK_BUFFER_BUCKET
  if (!bucket) {
    return false
  }

  const record: BufferedIngestRecord = {
    payload,
    buffered_at: new Date().toISOString(),
    error_code: ingestFailure.errorCode,
    error_message: ingestFailure.errorMessage,
    status_code: ingestFailure.statusCode,
  }

  const key = buildBufferedObjectKey(config, payload)
  await bucket.put(key, JSON.stringify(record))
  return true
}

async function replayBufferedIngests(env: Env, config: RuntimeConfig, deadlineAt: number): Promise<ReplaySummary> {
  const bucket = env.OPS_FALLBACK_BUFFER_BUCKET
  if (!bucket) {
    return { attempted: 0, replayed: 0, failed: 0 }
  }

  const prefix = `${config.fallbackBufferPrefix}/${BUFFER_PATH}/`
  const listed = await bucket.list({
    prefix,
    limit: config.replayBatchSize,
  })

  let attempted = 0
  let replayed = 0
  let failed = 0

  for (const object of listed.objects) {
    if (boundedTimeout(config.ingestTimeoutMs, deadlineAt) === 0) {
      break
    }

    const body = await bucket.get(object.key)
    if (!body) {
      continue
    }

    attempted += 1
    let payload: IngestPayload | null = null
    try {
      const record = JSON.parse(await body.text()) as BufferedIngestRecord
      payload = record.payload
    } catch {
      payload = null
    }

    if (!payload) {
      await bucket.delete(object.key)
      continue
    }

    const ingest = await postIngestPayload(payload, config, deadlineAt)
    if (ingest.ok) {
      replayed += 1
      await bucket.delete(object.key)
      continue
    }

    failed += 1
    break
  }

  return { attempted, replayed, failed }
}

function criticalStateObjectKey(config: RuntimeConfig): string {
  return `${config.fallbackBufferPrefix}/${STATE_PATH}`
}

function isValidCriticalState(value: unknown): value is CriticalIngestState {
  if (!value || typeof value !== "object") {
    return false
  }
  const maybe = value as Partial<CriticalIngestState>
  return (
    typeof maybe.streak === "number" &&
    typeof maybe.last_alerted_streak === "number" &&
    typeof maybe.updated_at === "string"
  )
}

async function loadCriticalIngestState(env: Env, config: RuntimeConfig): Promise<CriticalIngestState> {
  const bucket = env.OPS_FALLBACK_BUFFER_BUCKET
  if (!bucket) {
    return inMemoryCriticalIngestState
  }

  const object = await bucket.get(criticalStateObjectKey(config))
  if (!object) {
    return inMemoryCriticalIngestState
  }

  try {
    const parsed = JSON.parse(await object.text()) as unknown
    if (isValidCriticalState(parsed)) {
      return parsed
    }
  } catch {
    return inMemoryCriticalIngestState
  }

  return inMemoryCriticalIngestState
}

async function saveCriticalIngestState(env: Env, config: RuntimeConfig, state: CriticalIngestState): Promise<void> {
  inMemoryCriticalIngestState = state
  const bucket = env.OPS_FALLBACK_BUFFER_BUCKET
  if (!bucket) {
    return
  }
  await bucket.put(criticalStateObjectKey(config), JSON.stringify(state))
}

function hasTwilioConfig(env: Env): boolean {
  return Boolean(
    env.OPS_TWILIO_ACCOUNT_SID &&
      env.OPS_TWILIO_AUTH_TOKEN &&
      env.OPS_TWILIO_WHATSAPP_FROM &&
      env.OPS_WHATSAPP_TO_CRITICAL,
  )
}

function normalizeWhatsAppTarget(raw: string): string {
  return raw.startsWith("whatsapp:") ? raw : `whatsapp:${raw}`
}

async function sendTwilioFallbackAlert(
  env: Env,
  config: RuntimeConfig,
  failedCriticalIngests: IngestFailure[],
  runID: string,
  impairmentStreak: number,
  deadlineAt: number,
): Promise<boolean> {
  if (!hasTwilioConfig(env)) {
    return false
  }

  const timeoutMs = boundedTimeout(config.twilioTimeoutMs, deadlineAt)
  if (timeoutMs === 0) {
    return false
  }

  const accountSID = env.OPS_TWILIO_ACCOUNT_SID as string
  const authToken = env.OPS_TWILIO_AUTH_TOKEN as string
  const from = normalizeWhatsAppTarget(env.OPS_TWILIO_WHATSAPP_FROM as string)
  const to = normalizeWhatsAppTarget(env.OPS_WHATSAPP_TO_CRITICAL as string)
  const failedMonitorKeys = Array.from(new Set(failedCriticalIngests.map((failure) => failure.result.monitor.key))).join(", ")

  const message = `[chalk-ops-monitor] Critical ingest impairment (streak=${impairmentStreak}). run_id=${runID} failed_monitors=${failedMonitorKeys}. Incident truth may be delayed.`
  const body = new URLSearchParams({
    To: to,
    From: from,
    Body: message,
  })

  const response = await fetchWithTimeout(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSID}/Messages.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${accountSID}:${authToken}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    timeoutMs,
  )

  return response.ok
}

async function maybeSendCriticalIngestAlert(
  env: Env,
  config: RuntimeConfig,
  ingestFailures: IngestFailure[],
  runID: string,
  deadlineAt: number,
): Promise<TwilioAlertSummary> {
  const failedCriticalIngests = ingestFailures.filter(
    (failure) => failure.result.monitor.severity === "critical" && failure.result.status === "failed",
  )
  const criticalImpairment = failedCriticalIngests.length > 0

  const previousState = await loadCriticalIngestState(env, config)
  const nextStreak = criticalImpairment ? previousState.streak + 1 : 0
  const shouldAttemptAlert =
    criticalImpairment &&
    nextStreak >= config.twilioAlertThreshold &&
    previousState.last_alerted_streak < config.twilioAlertThreshold

  let alertSent = false
  if (shouldAttemptAlert) {
    try {
      alertSent = await sendTwilioFallbackAlert(env, config, failedCriticalIngests, runID, nextStreak, deadlineAt)
    } catch (error) {
      console.error("ops-monitor.twilio.alert.error", {
        run_id: runID,
        error: error instanceof Error ? error.message : String(error),
      })
      alertSent = false
    }
  }

  const nextState: CriticalIngestState = {
    streak: nextStreak,
    last_alerted_streak: criticalImpairment
      ? alertSent
        ? config.twilioAlertThreshold
        : previousState.last_alerted_streak
      : 0,
    updated_at: new Date().toISOString(),
  }

  await saveCriticalIngestState(env, config, nextState)
  return {
    attempted: shouldAttemptAlert,
    sent: alertSent,
    impairmentStreak: nextStreak,
  }
}

export async function runMonitorCycle(env: Env, scheduledAt = new Date()): Promise<RunSummary> {
  const config = readRuntimeConfig(env)
  const runID = buildRunID(scheduledAt)
  const deadlineAt = Date.now() + config.runDeadlineMs

  console.log("ops-monitor.run.started", {
    run_id: runID,
    check_count: DEFAULT_MONITORS.length,
    ingest_url: config.ingestURL,
  })

  const replaySummary = await replayBufferedIngests(env, config, deadlineAt)
  if (replaySummary.attempted > 0) {
    console.log("ops-monitor.replay.completed", {
      run_id: runID,
      replay_attempted: replaySummary.attempted,
      replay_succeeded: replaySummary.replayed,
      replay_failed: replaySummary.failed,
    })
  }

  const checks = await mapWithConcurrency(DEFAULT_MONITORS, config.maxParallelChecks, (monitor) =>
    executeMonitorCheck(monitor, config, runID, deadlineAt),
  )

  const failures: IngestFailure[] = []
  let ingestSuccessCount = 0
  let bufferedCount = 0

  for (const check of checks) {
    const payload = buildIngestPayload(check, config)
    const ingest = await postIngestPayload(payload, config, deadlineAt)

    if (ingest.ok) {
      ingestSuccessCount += 1
      console.log("ops-monitor.ingest.ok", {
        run_id: runID,
        monitor_key: check.monitor.key,
        status: check.status,
        latency_ms: check.latencyMs,
        result_key: check.resultKey,
        ingest_status: ingest.statusCode,
      })
      continue
    }

    failures.push({
      result: check,
      payload,
      attempts: ingest.attempts,
      statusCode: ingest.statusCode,
      errorCode: ingest.errorCode,
      errorMessage: ingest.errorMessage,
    })

    console.error("ops-monitor.ingest.failed", {
      run_id: runID,
      monitor_key: check.monitor.key,
      status: check.status,
      latency_ms: check.latencyMs,
      result_key: check.resultKey,
      ingest_status: ingest.statusCode,
      error_code: ingest.errorCode,
      error_message: ingest.errorMessage,
    })

    const buffered = await bufferFailedIngest(env, config, payload, ingest)
    if (buffered) {
      bufferedCount += 1
      console.warn("ops-monitor.ingest.buffered", {
        run_id: runID,
        monitor_key: check.monitor.key,
        result_key: check.resultKey,
      })
    }
  }

  const twilioSummary = await maybeSendCriticalIngestAlert(env, config, failures, runID, deadlineAt)

  const summary: RunSummary = {
    run_id: runID,
    checked_count: checks.length,
    healthy_count: checks.filter((check) => check.status === "healthy").length,
    failed_count: checks.filter((check) => check.status === "failed").length,
    ingest_success_count: ingestSuccessCount,
    ingest_failure_count: failures.length,
    replay_attempted: replaySummary.attempted,
    replay_succeeded: replaySummary.replayed,
    replay_failed: replaySummary.failed,
    buffered_count: bufferedCount,
    twilio_alert_attempted: twilioSummary.attempted,
    twilio_alert_sent: twilioSummary.sent,
  }

  console.log("ops-monitor.run.completed", summary)
  return summary
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
    },
  })
}

export const __internal = {
  DEFAULT_MONITORS,
  resetForTests() {
    inMemoryCriticalIngestState = {
      streak: 0,
      last_alerted_streak: 0,
      updated_at: new Date(0).toISOString(),
    }
  },
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/run") {
      try {
        const summary = await runMonitorCycle(env)
        return json(summary, 200)
      } catch (error) {
        return json(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          500,
        )
      }
    }

    return json({ ok: true, worker: "chalk-ops-monitor" }, 200)
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runMonitorCycle(env, new Date(controller.scheduledTime))
    } catch (error) {
      console.error("ops-monitor.run.error", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
}
