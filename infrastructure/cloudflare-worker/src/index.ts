import { generateSignature, isTimestampFresh, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "./signature"
import type { CallbackPayload, DispatchRequest, QueueJob, TranscriptionResult } from "./types"

const MAIN_QUEUE = "chalk-post-meeting-transcription"
const DLQ_QUEUE = "chalk-post-meeting-transcription-dlq"

export interface Env {
  AI: AiBinding
  TRANSCRIPTION_QUEUE: Queue<QueueJob>
  CLOUDFLARE_MODEL: string
  CHALK_TRANSCRIPTION_DISPATCH_SECRET: string
  CHALK_TRANSCRIPTION_CALLBACK_SECRET: string
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function badRequest(error: string, status = 400): Response {
  return json({ error }, status)
}

function assertDispatchRequest(value: DispatchRequest): void {
  if (!value.transcript_id || !value.recording_id || !value.room_id || !value.audio_url || !value.callback_url) {
    throw new Error("missing required fields")
  }
}

async function handleDispatch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return badRequest("method not allowed", 405)
  }

  const body = await request.text()
  const signature = request.headers.get(SIGNATURE_HEADER)
  const timestampRaw = request.headers.get(TIMESTAMP_HEADER)
  if (!signature || !timestampRaw) {
    return badRequest("missing signature headers", 401)
  }

  const timestamp = Number(timestampRaw)
  if (!Number.isFinite(timestamp) || !isTimestampFresh(timestamp)) {
    return badRequest("timestamp expired", 401)
  }

  if (!verifySignature(env.CHALK_TRANSCRIPTION_DISPATCH_SECRET, timestamp, body, signature)) {
    return badRequest("invalid signature", 401)
  }

  const parsed = JSON.parse(body) as DispatchRequest
  assertDispatchRequest(parsed)

  const job: QueueJob = {
    ...parsed,
    provider_job_id: crypto.randomUUID(),
  }

  await env.TRANSCRIPTION_QUEUE.send(job)
  return json({ accepted: true, job_id: job.provider_job_id }, 202)
}

async function sendCallback(env: Env, callbackURL: string, payload: CallbackPayload): Promise<void> {
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000)
  const response = await fetch(callbackURL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TIMESTAMP_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: generateSignature(env.CHALK_TRANSCRIPTION_CALLBACK_SECRET, timestamp, body),
    },
    body,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`callback failed: status=${response.status} body=${text}`)
  }
}

function normalizeTranscriptionResult(result: any): TranscriptionResult {
  const text = typeof result?.text === "string" ? result.text : ""
  const rawSegments = Array.isArray(result?.segments) ? result.segments : []
  const transcriptionInfo = result?.transcription_info ?? {}
  const segments = rawSegments.map((segment: any) => ({
    start: Number(segment?.start ?? 0),
    end: Number(segment?.end ?? 0),
    text: typeof segment?.text === "string" ? segment.text.trim() : "",
  }))

  return {
    text,
    language: typeof transcriptionInfo?.language === "string" ? transcriptionInfo.language : "",
    duration_seconds: Math.floor(Number(transcriptionInfo?.duration ?? 0)),
    word_count: Number(result?.word_count ?? text.split(/\s+/).filter(Boolean).length),
    segments,
  }
}

async function processQueueJob(message: QueueMessage<QueueJob>, env: Env): Promise<void> {
  const job = message.body
  const audioResponse = await fetch(job.audio_url)
  if (!audioResponse.ok || !audioResponse.body) {
    throw new Error(`audio fetch failed: status=${audioResponse.status}`)
  }

  const contentType = audioResponse.headers.get("content-type") || "audio/webm"
  const aiResult = await env.AI.run(job.provider_model || env.CLOUDFLARE_MODEL, {
    audio: {
      body: audioResponse.body,
      contentType,
    },
    task: "transcribe",
    ...(job.language_hint ? { language: job.language_hint } : {}),
  })

  const payload: CallbackPayload = {
    transcript_id: job.transcript_id,
    recording_id: job.recording_id,
    room_id: job.room_id,
    provider: "cloudflare",
    status: "completed",
    provider_job_id: job.provider_job_id,
    result: normalizeTranscriptionResult(aiResult),
  }

  await sendCallback(env, job.callback_url, payload)
  message.ack()
}

async function processDLQJob(message: QueueMessage<QueueJob>, env: Env): Promise<void> {
  const job = message.body
  const payload: CallbackPayload = {
    transcript_id: job.transcript_id,
    recording_id: job.recording_id,
    room_id: job.room_id,
    provider: "cloudflare",
    status: "failed",
    provider_job_id: job.provider_job_id,
    error_message: "cloudflare transcription moved to DLQ after retries were exhausted",
    provider_error_code: "queue_dlq",
    provider_error_metadata: {
      queue: DLQ_QUEUE,
      attempts: message.attempts,
      source: "cloudflare_queue_dlq",
    },
  }

  await sendCallback(env, job.callback_url, payload)
  message.ack()
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/dispatch") {
      return handleDispatch(request, env)
    }
    return badRequest("not found", 404)
  },

  async queue(batch: MessageBatch<QueueJob>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (batch.queue === DLQ_QUEUE) {
          await processDLQJob(message, env)
          continue
        }
        await processQueueJob(message, env)
      } catch (_error) {
        message.retry()
      }
    }
  },
}
