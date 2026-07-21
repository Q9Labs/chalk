import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { createWebhookProcessor, verifyWebhook } from "../../../sdks/typescript/client/dist/webhooks/index.js";

const coreEventTypes = ["room.created", "room.updated", "room.archived", "room.restored", "session.started", "session.ended", "participant.joined", "participant.left"];

async function main() {
  const host = "127.0.0.1";
  const port = Number(required("CHALK_WEBHOOK_RECEIVER_PORT"));
  const secretFile = required("CHALK_WEBHOOK_RECEIVER_SECRET_FILE");
  const stateFile = required("CHALK_WEBHOOK_RECEIVER_STATE_FILE");
  const inboxFile = required("CHALK_WEBHOOK_RECEIVER_INBOX_FILE");
  const store = new JSONStore(stateFile, {
    request_count: 0,
    first_failure_returned: false,
    first_failure_signature_verified: false,
    side_effect_count: 0,
    side_effect_count_by_event: {},
    handled_event_ids_by_type: {},
    body_sha256_by_event: {},
    outcomes: [],
  });
  const inbox = new DurableWebhookInbox(inboxFile);
  const secrets = async () => [String(JSON.parse(await readFile(secretFile, "utf8")).secret)];
  const processor = createWebhookProcessor({
    secrets,
    inbox,
    handlers: {
      ...Object.fromEntries(
        coreEventTypes.map((eventType) => [
          eventType,
          async (event) => {
            await store.update((state) => ({
              ...state,
              side_effect_count: state.side_effect_count + 1,
              side_effect_count_by_event: { ...(state.side_effect_count_by_event ?? {}), [eventType]: (state.side_effect_count_by_event?.[eventType] ?? 0) + 1 },
              handled_event_ids_by_type: { ...(state.handled_event_ids_by_type ?? {}), [eventType]: event.id },
              handled_event_id: event.id,
            }));
          },
        ]),
      ),
      "endpoint.test": async () => {
        // A signed canary proves delivery without creating a consumer side effect.
      },
    },
    onDiagnostic: async (diagnostic) => {
      await store.update((state) => ({ ...state, diagnostics: [...(state.diagnostics ?? []), diagnostic] }));
    },
  });

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/readyz") {
        response.writeHead(200).end("ready");
        return;
      }
      if (request.method !== "POST" || request.url !== "/webhook") {
        response.writeHead(404).end();
        return;
      }

      const rawBody = await readRawBody(request);
      const digest = createHash("sha256").update(rawBody).digest("hex");
      const eventID = request.headers["webhook-id"];
      if (typeof eventID !== "string" || eventID.length === 0) throw new Error("Webhook-ID is required.");
      const state = await store.update((current) => {
        const previousDigest = current.body_sha256_by_event?.[eventID];
        if (previousDigest && previousDigest !== digest) throw new Error("Webhook retries changed the signed raw body bytes.");
        return {
          ...current,
          request_count: current.request_count + 1,
          body_sha256_by_event: { ...(current.body_sha256_by_event ?? {}), [eventID]: digest },
        };
      });
      if (!state.first_failure_returned) {
        await verifyWebhook({ rawBody, headers: request.headers, secrets: await secrets() });
        await store.update((current) => ({
          ...current,
          first_failure_returned: true,
          first_failure_signature_verified: true,
          outcomes: [...current.outcomes, "retryable_failure"],
        }));
        response.writeHead(503, { "Retry-After": "1" }).end();
        return;
      }

      const result = await processor.process({ rawBody, headers: request.headers });
      await store.update((current) => ({ ...current, outcomes: [...current.outcomes, result.outcome], last_event_id: result.eventId ?? null }));
      const headers = result.retryAfterSeconds === undefined ? {} : { "Retry-After": String(result.retryAfterSeconds) };
      response.writeHead(result.status, headers).end();
    } catch (error) {
      await store.update((state) => ({ ...state, receiver_error: error instanceof Error ? error.message : String(error) })).catch(() => {});
      response.writeHead(500).end();
    }
  });

  server.listen(port, host, () => process.stdout.write(`${JSON.stringify({ event: "webhook.receiver.ready", host, port })}\n`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

class JSONStore {
  #file;
  #initial;
  #pending = Promise.resolve();

  constructor(file, initial) {
    this.#file = file;
    this.#initial = initial;
  }

  read() {
    return this.#pending.then(() => readJSON(this.#file, this.#initial));
  }

  update(change) {
    const operation = this.#pending.then(async () => {
      const current = await readJSON(this.#file, this.#initial);
      const next = change(current);
      await atomicJSON(this.#file, next);
      return next;
    });
    this.#pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

class DurableWebhookInbox {
  #store;

  constructor(file) {
    this.#store = new JSONStore(file, { entries: {} });
  }

  async acquire({ eventId, leaseMilliseconds }) {
    let result;
    await this.#store.update((state) => {
      const now = Date.now();
      const current = state.entries[eventId];
      if (current?.state === "completed") {
        result = { state: "completed" };
        return state;
      }
      if (current?.state === "leased" && current.expires_at > now) {
        result = { state: "busy", retryAfterSeconds: Math.max(1, Math.ceil((current.expires_at - now) / 1_000)) };
        return state;
      }
      const token = randomUUID();
      result = { state: "acquired", token };
      return { ...state, entries: { ...state.entries, [eventId]: { state: "leased", token, expires_at: now + leaseMilliseconds } } };
    });
    return result;
  }

  async complete({ eventId, token }) {
    await this.#store.update((state) => {
      const current = state.entries[eventId];
      if (current?.state !== "leased" || current.token !== token) throw new Error("Webhook inbox lease is not owned.");
      return { ...state, entries: { ...state.entries, [eventId]: { state: "completed", completed_at: Date.now() } } };
    });
  }

  async release({ eventId, token }) {
    await this.#store.update((state) => {
      if (state.entries[eventId]?.state !== "leased" || state.entries[eventId]?.token !== token) return state;
      const entries = { ...state.entries };
      delete entries[eventId];
      return { ...state, entries };
    });
  }
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Webhook body exceeded the test receiver limit.");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function atomicJSON(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

await main();
