/** Join probe: admit a participant and complete the Sync handshake the way a client does, without media. */

export interface ProbeEnv {
  PROBE_API_KEY?: string;
  PROBE_TENANT_ID?: string;
  PROBE_SPACE_ID?: string;
  PROBE_STATE?: KVNamespace;
}

export type JoinResult = { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly stage: ProbeStage; readonly detail: string };
export type ProbeStage = "create episode" | "admit participant" | "sync handshake";
/** `pending` is a message that was decided but not yet delivered; it stays in the state until the webhook accepts it. */
export type ProbeState = { readonly status: "up" | "down"; readonly failures: number; readonly pending?: string };

/** A single failed cycle is not paged: two in a row (ten minutes) are. */
export const FAILURES_BEFORE_PAGE = 2;
const STATE_KEY = "join-probe";
const STEP_TIMEOUT_MS = 10_000;

export function transition(previous: ProbeState | null, result: JoinResult): { readonly next: ProbeState; readonly message?: string } {
  if (result.ok) {
    const next: ProbeState = { status: "up", failures: 0 };
    return previous?.status === "down" ? { next, message: `Chalk join probe recovered: a client can join again (${result.ms} ms).` } : { next };
  }
  const failures = (previous?.failures ?? 0) + 1;
  const wasDown = previous?.status === "down";
  const down = wasDown || failures >= FAILURES_BEFORE_PAGE;
  const next: ProbeState = { status: down ? "down" : "up", failures };
  return !wasDown && down ? { next, message: `Chalk join probe failed at "${result.stage}": ${result.detail}. A client cannot join. An engineer must investigate; this message repeats only when the state changes.` } : { next };
}

class StageError extends Error {
  readonly stage: ProbeStage;
  constructor(stage: ProbeStage, detail: string) {
    super(detail);
    this.stage = stage;
  }
}

async function call(stage: ProbeStage, env: Required<Pick<ProbeEnv, "PROBE_API_KEY">>, url: URL, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${env.PROBE_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "User-Agent": "Chalk-Uptime/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error: unknown) => {
    throw new StageError(stage, error instanceof Error ? error.name : "request failed");
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new StageError(stage, `HTTP ${response.status}`);
  }
  return response.json();
}

function field(value: unknown, key: string, stage: ProbeStage): string {
  const found = typeof value === "object" && value !== null && key in value ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  if (typeof found !== "string" || found === "") throw new StageError(stage, `response has no ${key}`);
  return found;
}

function isProbeState(value: unknown): value is ProbeState {
  return typeof value === "object" && value !== null && "status" in value && "failures" in value && (value.status === "up" || value.status === "down") && typeof value.failures === "number" && (!("pending" in value) || value.pending === undefined || typeof value.pending === "string");
}

function isWelcome(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    const frame: unknown = JSON.parse(data);
    return typeof frame === "object" && frame !== null && "type" in frame && frame.type === "welcome";
  } catch {
    return false;
  }
}

function handshake(sync: URL, token: string): Promise<void> {
  const url = new URL("/v1/sync", sync);
  return fetch(url, { headers: { Upgrade: "websocket", "User-Agent": "Chalk-Uptime/1.0" }, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) }).then(
    (response) =>
      new Promise<void>((resolve, reject) => {
        const socket = response.webSocket;
        if (!socket) return reject(new StageError("sync handshake", `no upgrade (HTTP ${response.status})`));
        const timer = setTimeout(() => finish(new StageError("sync handshake", "no welcome within 10 s")), STEP_TIMEOUT_MS);
        const finish = (error?: StageError) => {
          clearTimeout(timer);
          socket.close(1000, "probe done");
          error ? reject(error) : resolve();
        };
        socket.accept();
        socket.addEventListener("message", (event) => {
          if (isWelcome(event.data)) finish();
        });
        socket.addEventListener("close", (event) => finish(new StageError("sync handshake", `closed ${event.code} before welcome`)));
        socket.send(JSON.stringify({ type: "hello", protocol: 1, token, streams: { control: { cursor: null }, media: { cursor: null }, presence: { cursor: null }, requests: { cursor: null } } }));
      }),
    (error: unknown) => {
      throw new StageError("sync handshake", error instanceof Error ? error.name : "connect failed");
    },
  );
}

export async function joinProbe(env: ProbeEnv, api: URL, sync: URL): Promise<JoinResult> {
  const { PROBE_API_KEY, PROBE_TENANT_ID, PROBE_SPACE_ID } = env;
  if (!PROBE_API_KEY || !PROBE_TENANT_ID || !PROBE_SPACE_ID) throw new Error("PROBE_API_KEY, PROBE_TENANT_ID and PROBE_SPACE_ID must all be set");
  const started = Date.now();
  const space = `/v1/tenants/${encodeURIComponent(PROBE_TENANT_ID)}/spaces/${encodeURIComponent(PROBE_SPACE_ID)}`;
  const auth = { PROBE_API_KEY };
  let episodePath: string | null = null;
  try {
    const episode = await call("create episode", auth, new URL(`${space}/episodes`, api), {});
    episodePath = `${space}/episodes/${encodeURIComponent(field(episode, "id", "create episode"))}`;
    const admitted = await call("admit participant", auth, new URL(`${episodePath}/participants`, api), { name: "uptime probe", role: "collaborator", admission: "direct" });
    await handshake(sync, field(admitted, "sync_token", "admit participant"));
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return error instanceof StageError ? { ok: false, stage: error.stage, detail: error.message } : { ok: false, stage: "sync handshake", detail: "unexpected error" };
  } finally {
    if (episodePath) await call("create episode", auth, new URL(`${episodePath}/end`, api)).catch(() => undefined);
  }
}

/**
 * Runs the probe, keeps its state, and delivers the one message the state change calls for.
 * The message is stored as `pending` before delivery and cleared after it, so a failed delivery is retried on the next cycle instead of being lost.
 */
export async function runJoinProbe(env: ProbeEnv, api: URL, sync: URL, deliver: (message: string) => Promise<void>): Promise<void> {
  if (!env.PROBE_STATE) throw new Error("PROBE_STATE must be bound when the join probe is configured");
  const stored = await env.PROBE_STATE.get(STATE_KEY, "json");
  const previous = isProbeState(stored) ? stored : null;
  const result = await joinProbe(env, api, sync);
  console.log("join probe", JSON.stringify(result));
  const { next, message } = transition(previous, result);
  const pending = message ?? previous?.pending;
  await env.PROBE_STATE.put(STATE_KEY, JSON.stringify(pending ? { ...next, pending } : next));
  console.log("join probe state", JSON.stringify(next), pending ? "message" : "silent");
  if (!pending) return;
  await deliver(pending);
  await env.PROBE_STATE.put(STATE_KEY, JSON.stringify(next));
}
