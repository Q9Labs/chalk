// usage: node mkspace.mjs <label> ; env CHALK_API_KEY, CHALK_TENANT; writes /tmp/dress/<label>.json (0600)
import { writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
const API = "https://nightly-api.chalkmeet.com",
  WEB = "https://nightly.chalkmeet.com";
const label = process.argv[2];
const t = `/v1/tenants/${process.env.CHALK_TENANT}`;
const call = async (method, path, body) => {
  const r = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.CHALK_API_KEY}`, Origin: WEB, "Idempotency-Key": randomUUID(), "X-Chalk-Media-Providers": "cloudflare_sfu,chalk_sfu", "User-Agent": "Chalk-Dress-Rehearsal/1.0" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!r.ok) {
    console.error(method, path, r.status, typeof json === "string" ? json.slice(0, 200) : (json.error ?? json.code ?? Object.keys(json)));
    process.exit(1);
  }
  return json;
};
const space = await call("POST", `${t}/spaces`, {
  name: `dress-rehearsal:${label}`,
  slug: `dress-${randomUUID()}`,
  metadata: { dress_rehearsal: label },
  media_plane: "chalk_sfu",
  recording_policy: "manual",
  transcription_policy: "on_demand",
  default_episode_duration_seconds: 1800,
  maximum_episode_duration_seconds: 1800,
  linger_window_seconds: 60,
  admission_policy: { mode: "open" },
});
const episode = await call("POST", `${t}/spaces/${space.id}/episodes`, { metadata: { dress_rehearsal: label } });
const invite = await call("PATCH", `${t}/spaces/${space.id}/public-invite`, { enabled: true });
const u = new URL(invite.canonical_url);
const out = { spaceId: space.id, episodeId: episode.id, media_plane: space.media_plane, entry: u.pathname + u.search + u.hash, url: WEB + u.pathname + u.search + u.hash };
writeFileSync(`/tmp/dress/${label}.json`, JSON.stringify(out));
chmodSync(`/tmp/dress/${label}.json`, 0o600);
console.log(JSON.stringify({ spaceId: out.spaceId, episodeId: out.episodeId, media_plane: out.media_plane, inviteHost: u.host, entryShape: u.pathname.replace(/[a-z]/g, "x") }));
