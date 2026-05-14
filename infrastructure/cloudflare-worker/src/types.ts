export type DispatchRequest = {
  transcript_id: string
  recording_id: string
  room_id: string
  audio_url: string
  audio_storage_path: string
  language_hint?: string
  callback_url: string
  provider_model?: string
}

export type QueueJob = DispatchRequest & {
  provider_job_id: string
}

export type TranscriptionResult = {
  text: string
  language: string
  duration_seconds: number
  word_count: number
  segments: Array<{
    start: number
    end: number
    text: string
  }>
}

export type CallbackPayload =
  | {
      transcript_id: string
      recording_id: string
      room_id: string
      provider: "cloudflare"
      status: "completed"
      provider_job_id: string
      result: TranscriptionResult
    }
  | {
      transcript_id: string
      recording_id: string
      room_id: string
      provider: "cloudflare"
      status: "failed"
      provider_job_id: string
      error_message: string
      provider_error_code?: string
      provider_error_metadata?: Record<string, unknown>
    }
