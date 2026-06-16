const asRecord = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export async function getRecordingPlaybackUrl(apiUrl: string, recordingId: string, token: string) {
  const res = await fetch(`${apiUrl}/api/v1/recordings/${recordingId}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("playback unauthorized");
  }
  if (res.status === 404) {
    throw new Error("recording not found");
  }
  if (res.status === 410) {
    throw new Error("recording expired");
  }

  const payload = asRecord(await res.json().catch(() => null));
  if (!res.ok) {
    throw new Error(asString(payload?.error) ?? asString(payload?.message) ?? "failed to load playback");
  }

  if (payload?.status && payload.status !== "ready") {
    throw new Error(asString(payload?.message) ?? `recording ${String(payload.status)}`);
  }

  if (typeof payload?.download_url !== "string" || payload.download_url.length === 0) {
    throw new Error("playback URL unavailable");
  }

  return payload.download_url;
}

export async function getRecordingShareUrl(apiUrl: string, recordingId: string, token: string) {
  const res = await fetch(`${apiUrl}/api/v1/recordings/${recordingId}/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  const payload = asRecord(await res.json().catch(() => null));
  if (!res.ok) {
    throw new Error(asString(payload?.error) ?? "failed to create share link");
  }

  if (typeof payload?.share_token !== "string" || payload.share_token.length === 0) {
    throw new Error("share link unavailable");
  }

  return new URL(`/share/${payload.share_token}`, window.location.origin).toString();
}

export async function downloadRecordingFromDashboard(apiUrl: string, recordingId: string, token: string) {
  const url = await getRecordingPlaybackUrl(apiUrl, recordingId, token);
  window.open(url, "_blank", "noopener,noreferrer");
}
