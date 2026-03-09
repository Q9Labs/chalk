import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

async function tryGetContentLength(downloadUrl: string): Promise<number | null> {
  try {
    const resp = await fetch(downloadUrl, { method: "HEAD" });
    if (!resp.ok) return null;
    const len = resp.headers.get("content-length");
    if (!len) return null;
    const n = Number.parseInt(len, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function generateR2PresignedUrl(opts: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; key: string; expiresInSeconds: number }): Promise<{ url: string; expiresAtIso: string }> {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    },
    forcePathStyle: true,
  });

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: opts.bucket,
      Key: opts.key,
    }),
    { expiresIn: opts.expiresInSeconds },
  );

  const expiresAtIso = new Date(Date.now() + opts.expiresInSeconds * 1000).toISOString();
  return { url, expiresAtIso };
}

export async function triggerSimulatedCloudflareWebhook(opts: { apiBaseUrl: string; cfRecordingId: string; downloadUrl: string; downloadUrlExpiryIso: string; roomCloudflareMeetingId: string; outputFileName?: string }): Promise<void> {
  const now = Date.now();
  const fileSize = await tryGetContentLength(opts.downloadUrl);
  const body = {
    event: "recording.statusUpdate",
    recording: {
      id: opts.cfRecordingId,
      download_url: opts.downloadUrl,
      download_url_expiry: opts.downloadUrlExpiryIso,
      file_size: fileSize ?? 1048576,
      session_id: "e2e-test-session",
      output_file_name: opts.outputFileName ?? "e2e-test-recording.mp4",
      status: "COMPLETED",
      invoked_time: new Date(now - 5 * 60_000).toISOString(),
      started_time: new Date(now - 4 * 60_000).toISOString(),
      stopped_time: new Date(now - 1 * 60_000).toISOString(),
    },
    meeting: {
      id: opts.roomCloudflareMeetingId,
      title: "E2E Test Meeting",
    },
  };

  const resp = await fetch(`${opts.apiBaseUrl}/api/v1/webhooks/cloudflare/recording`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Trigger webhook failed: HTTP ${resp.status} ${text}`);
  }
}
