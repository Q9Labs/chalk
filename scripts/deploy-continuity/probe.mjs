// Holds one Participant on an Episode while a deploy runs, and reports what the Participant would have seen:
// windows where the API answered nothing, and every Sync socket drop with the time until the next welcome.
//
//   CHALK_API_URL=... CHALK_SYNC_URL=... CHALK_API_KEY=... CHALK_TENANT_ID=... CHALK_SPACE_ID=... \
//     node scripts/deploy-continuity/probe.mjs --seconds 1800 > report.json
//
// It prints one JSON report on exit (Ctrl-C ends it early) and one line per change while it runs.
import { setTimeout as sleep } from "node:timers/promises";

const POLL_MS = 200;
const REQUEST_TIMEOUT_MS = 5_000;

export function windows(samples) {
  const found = [];
  let open = null;
  for (const { at, ok } of samples) {
    if (!ok && !open) open = at;
    if (ok && open !== null) {
      found.push({ from: open, to: at, seconds: (at - open) / 1000 });
      open = null;
    }
  }
  if (open !== null) found.push({ from: open, to: null, seconds: null });
  return found;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const iso = (ms) => new Date(ms).toISOString();

async function api(path, body) {
  const response = await fetch(new URL(path, required("CHALK_API_URL")), {
    method: body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${required("CHALK_API_KEY")}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function openSocket(token, drops) {
  const socket = new WebSocket(new URL("/v1/sync", required("CHALK_SYNC_URL")).href.replace(/^http/, "ws"));
  const state = { socket, welcomedAt: null };
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", protocol: 1, token, streams: { control: { cursor: null }, media: { cursor: null }, presence: { cursor: null }, requests: { cursor: null } } })));
  socket.addEventListener("close", (event) => {
    state.closed = `${event.code} ${event.reason}`.trim();
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string" && JSON.parse(event.data).type === "welcome") {
      state.welcomedAt = Date.now();
      const last = drops.at(-1);
      if (last && last.reconnectedAt === null) {
        last.reconnectedAt = state.welcomedAt;
        last.seconds = (state.welcomedAt - last.droppedAt) / 1000;
        console.error(`sync back after ${last.seconds} s`);
      } else if (!last) console.error("sync welcome");
    }
  });
  return state;
}

export async function main(seconds) {
  const space = `/v1/tenants/${encodeURIComponent(required("CHALK_TENANT_ID"))}/spaces/${encodeURIComponent(required("CHALK_SPACE_ID"))}`;
  const episode = await api(`${space}/episodes`, {});
  const episodePath = `${space}/episodes/${encodeURIComponent(episode.id)}`;
  const admitted = await api(`${episodePath}/participants`, { name: "continuity probe", role: "collaborator", admission: "direct" });
  const drops = [];
  const samples = [];
  let current = openSocket(admitted.sync_token, drops);
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  const until = Date.now() + seconds * 1000;
  let reconnecting = false;
  while (!stop && Date.now() < until) {
    const at = Date.now();
    const ok = await api(episodePath).then(
      () => true,
      () => false,
    );
    if (samples.at(-1)?.ok !== ok) console.error(`${iso(at)} API ${ok ? "answers" : "does not answer"}`);
    samples.push({ at, ok });
    const closed = current.socket.readyState === WebSocket.CLOSED;
    if (closed && !reconnecting) {
      reconnecting = true;
      drops.push({ droppedAt: Date.now(), reconnectedAt: null, seconds: null });
      console.error(`${iso(Date.now())} sync socket dropped (${current.closed ?? "no close frame"}), up for ${((Date.now() - (current.welcomedAt ?? Date.now())) / 1000).toFixed(1)} s`);
    }
    // A client retries with the same token; the probe retries once a second.
    if (closed && Date.now() - drops.at(-1).droppedAt >= 1000 * (drops.at(-1).attempts ?? 0)) {
      drops.at(-1).attempts = (drops.at(-1).attempts ?? 0) + 1;
      current = openSocket(admitted.sync_token, drops);
    }
    if (reconnecting && drops.at(-1).reconnectedAt !== null) reconnecting = false;
    await sleep(Math.max(0, POLL_MS - (Date.now() - at)));
  }
  current.socket.close(1000, "probe done");
  await api(`${episodePath}/end`, {}).catch(() => undefined);
  return { api_unavailable: windows(samples), sync_drops: drops.map(({ droppedAt, reconnectedAt, seconds: s }) => ({ dropped_at: iso(droppedAt), reconnected_at: reconnectedAt && iso(reconnectedAt), seconds: s })), samples: samples.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = process.argv.indexOf("--seconds");
  const seconds = flag > 0 ? Number(process.argv[flag + 1]) : 600;
  console.log(JSON.stringify(await main(seconds), null, 2));
}
