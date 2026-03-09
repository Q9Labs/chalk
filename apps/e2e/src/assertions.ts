import { createHmac } from "node:crypto";
import { poll } from "./poll";

export type AssertionResult = {
  name: string;
  ok: boolean;
  details?: string;
};

export type TenantPostMeetingWebhookConfig = {
  enabled: boolean;
  url?: string;
  secret?: string;
  include_recording: boolean;
  include_transcript: boolean;
  include_summary: boolean;
  include_action_items: boolean;
  transcription?: { provider?: string };
  ai?: { provider?: string; model?: string };
};

export function decodeTenantConfigFromApi(tenantConfigBase64: string): unknown {
  const raw = tenantConfigBase64.trim();
  if (raw.startsWith("{") || raw.startsWith("[")) {
    return JSON.parse(raw);
  }
  const bytes = Buffer.from(raw, "base64");
  const text = bytes.toString("utf8");
  return JSON.parse(text);
}

export function extractPostMeetingWebhookConfig(tenantConfig: unknown): TenantPostMeetingWebhookConfig {
  const cfg = (tenantConfig as any)?.post_meeting_webhook ?? {};
  return {
    enabled: Boolean(cfg.enabled),
    url: typeof cfg.url === "string" ? cfg.url : undefined,
    secret: typeof cfg.secret === "string" ? cfg.secret : undefined,
    include_recording: Boolean(cfg.include_recording),
    include_transcript: Boolean(cfg.include_transcript),
    include_summary: Boolean(cfg.include_summary),
    include_action_items: Boolean(cfg.include_action_items),
    transcription: cfg.transcription,
    ai: cfg.ai,
  };
}

export function buildUpdatedWebhookConfig(existing: TenantPostMeetingWebhookConfig, updates: { url: string; secret: string }): TenantPostMeetingWebhookConfig {
  const anyIncluded = existing.include_recording || existing.include_transcript || existing.include_summary || existing.include_action_items;
  return {
    ...existing,
    enabled: true,
    url: updates.url,
    secret: updates.secret,
    // Ensure we can at least get a delivery if the tenant has nothing enabled yet
    include_recording: anyIncluded ? existing.include_recording : true,
  };
}

function makeResult(name: string, ok: boolean, details?: string): AssertionResult {
  return ok ? { name, ok } : { name, ok, details };
}

function getHeader(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase());
}

function computeExpectedSignature(secret: string, timestamp: string, bodyText: string): string {
  const msg = `${timestamp}.${bodyText}`;
  const hex = createHmac("sha256", secret).update(msg).digest("hex");
  return `sha256=${hex}`;
}

function parseIntStrict(value: string | null): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

export function assertWebhookDelivery(opts: { headers: Headers; bodyText: string; payload: unknown; webhookSecret: string; roomId: string; recordingId: string; config: TenantPostMeetingWebhookConfig }): AssertionResult[] {
  const results: AssertionResult[] = [];
  const payload = opts.payload as any;

  const event = payload?.event;
  results.push(makeResult("payload.event === meeting.recording_ready", event === "meeting.recording_ready", `got ${JSON.stringify(event)}`));

  const meetingId = payload?.meeting?.id;
  results.push(makeResult("payload.meeting.id matches ROOM_ID", typeof meetingId === "string" && meetingId === opts.roomId, `got ${JSON.stringify(meetingId)}`));

  const startedAt = payload?.meeting?.started_at;
  const endedAt = payload?.meeting?.ended_at;
  results.push(makeResult("payload.meeting.started_at present", typeof startedAt === "string" && startedAt.length > 0));
  results.push(makeResult("payload.meeting.ended_at present", typeof endedAt === "string" && endedAt.length > 0));

  const rec = payload?.recording ?? null;
  if (opts.config.include_recording) {
    results.push(makeResult("payload.recording present", rec != null && typeof rec === "object"));
    const recId = rec?.id;
    results.push(makeResult("payload.recording.id matches RECORDING_ID", typeof recId === "string" && recId === opts.recordingId, `got ${JSON.stringify(recId)}`));
    const url = rec?.download_url ?? rec?.url;
    results.push(makeResult("payload.recording.(download_url|url) present", typeof url === "string" && url.length > 0));
    const size = rec?.size_bytes ?? rec?.sizeBytes;
    results.push(makeResult("payload.recording.size_bytes > 0", typeof size === "number" && size > 0));
  }

  if (opts.config.include_transcript) {
    const transcript = payload?.transcript ?? null;
    results.push(makeResult("payload.transcript present", transcript != null && typeof transcript === "object"));
    results.push(makeResult("payload.transcript.text non-empty", typeof transcript?.text === "string" && transcript.text.length > 0));
    const segments = transcript?.segments;
    results.push(makeResult("payload.transcript.segments non-empty", Array.isArray(segments) && segments.length > 0));
    if (opts.config.transcription?.provider) {
      results.push(makeResult("payload.transcript.provider matches tenant", typeof transcript?.provider === "string" && transcript.provider === opts.config.transcription.provider, `got ${JSON.stringify(transcript?.provider)} expected ${JSON.stringify(opts.config.transcription.provider)}`));
    }
  }

  if (opts.config.include_summary) {
    const summary = payload?.summary;
    const ok = (typeof summary === "string" && summary.length > 0) || (typeof summary === "object" && summary != null && typeof summary.text === "string" && summary.text.length > 0);
    results.push(makeResult("payload.summary present (string or {text})", ok));
  }

  if (opts.config.include_action_items) {
    const actionItems = payload?.action_items ?? payload?.summary?.action_items;
    results.push(makeResult("payload.action_items present", Array.isArray(actionItems)));
  }

  // Headers
  const sig = getHeader(opts.headers, "X-Chalk-Signature");
  const ts = getHeader(opts.headers, "X-Chalk-Timestamp");
  const ev = getHeader(opts.headers, "X-Chalk-Event");
  const deliveryId = getHeader(opts.headers, "X-Chalk-Delivery-ID");

  results.push(makeResult("header X-Chalk-Event === meeting.recording_ready", ev === "meeting.recording_ready"));
  results.push(makeResult("header X-Chalk-Delivery-ID present", typeof deliveryId === "string" && deliveryId.length > 0));

  const tsInt = parseIntStrict(ts);
  const nowSec = Math.floor(Date.now() / 1000);
  results.push(makeResult("header X-Chalk-Timestamp within 10 minutes", tsInt != null && Math.abs(nowSec - tsInt) <= 10 * 60, `now=${nowSec} ts=${tsInt}`));

  if (typeof sig === "string" && ts && sig.length > 0) {
    const expected = computeExpectedSignature(opts.webhookSecret, ts, opts.bodyText);
    const ok = sig === expected || sig === expected.slice("sha256=".length);
    results.push(makeResult("header X-Chalk-Signature valid", ok));
  } else {
    results.push(makeResult("header X-Chalk-Signature present", false));
  }

  return results;
}

export async function assertApiRecordingState(opts: { apiBaseUrl: string; jwt: string; recordingId: string; timeoutMs: number }): Promise<AssertionResult[]> {
  const recording = await poll<any>({
    timeoutMs: opts.timeoutMs,
    intervalMs: 2000,
    action: async () => {
      const resp = await fetch(`${opts.apiBaseUrl}/api/v1/recordings/${opts.recordingId}`, {
        headers: { Authorization: `Bearer ${opts.jwt}` },
      });
      if (!resp.ok) return null;
      return await resp.json();
    },
  });

  const status = recording?.status;
  const storagePath = recording?.storage_path;

  return [makeResult("api recording.status === ready", status === "ready", `got ${JSON.stringify(status)}`), makeResult("api recording.storage_path set", typeof storagePath === "string" && storagePath.length > 0, `got ${JSON.stringify(storagePath)}`)];
}
