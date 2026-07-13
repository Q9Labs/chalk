# Receive Chalk webhooks

Chalk delivers signed Events at least once and without ordering guarantees. A receiver must verify the exact request bytes, claim `event.id` in durable storage, make its side effect idempotent with that ID, and return a `2xx` response within ten seconds.

## Manage webhook endpoints

The main client exposes typed management calls for endpoint creation, updates, rotation, tests, and delivery inspection. Run the client as an Effect and supply a fresh idempotency key for every mutating request:

```ts
import { createChalkEffectClient } from "@q9labsai/chalk-client";
import { Effect } from "effect";

const createEndpoint = Effect.gen(function* () {
  const chalk = yield* createChalkEffectClient({
    baseUrl: "https://api.chalk.video",
    auth: { type: "bearer", token: process.env.CHALK_API_TOKEN! },
  });

  const endpoint = yield* chalk.default.createWebhookEndpoint({
    params: { tenant_id: "6706bfe4-2015-466a-b197-8ccd3f9e0d9b" },
    headers: { "Idempotency-Key": crypto.randomUUID() },
    payload: {
      api_version: 1,
      enabled: true,
      event_types: ["participant.joined"],
      name: "Operations",
      url: "https://hooks.example.com/chalk",
    },
  });

  yield* storeSecret(endpoint.secret);
  return endpoint;
});

await Effect.runPromise(createEndpoint);
```

The `secret` field appears only in create and rotate-secret responses. Store it immediately; list, get, update, test, and delivery responses cannot recover it. Update and delete calls require the endpoint revision as a quoted `If-Match` value such as `"3"`. Delivery listing accepts `state`, `event_type`, `page_size`, and `cursor`; delivery detail includes every attempt's outcome, HTTP status, timing, latency, and stable error code.

Install the client package and import the server-only receiver surface:

```ts
import { createWebhookProcessor, toWebhookResponse, type WebhookInbox } from "@q9labsai/chalk-client/webhooks";

const processor = createWebhookProcessor({
  secrets: () => loadCurrentAndPreviousSecrets(),
  inbox: durableInbox,
  handlers: {
    "participant.joined": async (event) => {
      await crm.upsertParticipant(event.data.object, { idempotencyKey: event.id });
    },
  },
});
```

Keep every `whsec_` value in server-side secret storage. During rotation, return both the current and previous secret from `secrets`; Chalk signs with both for the 24-hour overlap. Remove the previous value after its expiry. Artifact Events under `recording.*` and `transcript.*` are present in the version 1 type contract but remain reserved and unavailable for subscription until Chalk enables their production pipelines.

## Pass raw request bytes

`verifyWebhook` and the Processor accept `Uint8Array`, never parsed JSON or a string. Any parser that consumes, normalizes, or reserializes the request before verification breaks the signature boundary.

**Web `Request`, Next.js route handlers, and edge runtimes**

```ts
export async function POST(request: Request): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  return toWebhookResponse(await processor.process({ rawBody, headers: request.headers }));
}
```

Read `arrayBuffer()` once. In a Next.js App Router route, the same handler shape works directly; don't call `request.json()` first.

**Node HTTP**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";

export async function receive(request: IncomingMessage, response: ServerResponse) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  const rawBody = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
  const result = await processor.process({
    rawBody,
    headers: request.headers as Record<string, string | string[] | undefined>,
  });
  if (result.retryAfterSeconds !== undefined) response.setHeader("Retry-After", result.retryAfterSeconds);
  response.writeHead(result.status).end();
}
```

Enforce Chalk's 256 KiB body maximum while collecting bytes in a real server, and stop reading when the limit is exceeded.

**Express**

```ts
app.post("/chalk-webhooks", express.raw({ type: "application/json", limit: "256kb" }), async (request, response) => {
  const result = await processor.process({
    rawBody: new Uint8Array(request.body),
    headers: request.headers,
  });
  if (result.retryAfterSeconds !== undefined) response.set("Retry-After", String(result.retryAfterSeconds));
  response.sendStatus(result.status);
});
```

Register this route before a global `express.json()` middleware, or exclude it from that parser. The client package does not depend on Express.

**Hono**

```ts
app.post("/chalk-webhooks", async (context) => {
  const rawBody = new Uint8Array(await context.req.raw.arrayBuffer());
  return toWebhookResponse(await processor.process({ rawBody, headers: context.req.raw.headers }));
});
```

Read `context.req.raw`, not a parsed body helper. The client package does not depend on Hono.

## Implement a durable inbox

Keep completed Event IDs for at least Chalk's 30-day redelivery window. `acquire` must atomically create or replace an expired lease, report an unexpired lease as `busy`, and report retained completion as `completed`. `complete` and `release` must compare the lease token so an expired worker cannot overwrite a newer owner.

The Processor's default lease is 30 seconds. If the handler needs a different bound, set `leaseMilliseconds` to a positive integer no greater than 300,000; keep it comfortably above the handler's normal execution time and below the point where a crashed delivery would be needlessly delayed.

A PostgreSQL implementation can keep the state invariant in the table and expose acquisition as one transaction-scoped function:

```sql
CREATE TABLE chalk_webhook_inbox (
  event_id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('leased', 'completed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  CHECK (
    (state = 'leased' AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR
    (state = 'completed' AND lease_token IS NULL
      AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX chalk_webhook_inbox_completed_at_idx
  ON chalk_webhook_inbox (completed_at) WHERE state = 'completed';

CREATE FUNCTION acquire_chalk_webhook_event(
  requested_event_id uuid, requested_token uuid, lease_ms integer
) RETURNS TABLE (claim_state text, claim_token uuid, retry_after_seconds integer)
LANGUAGE plpgsql AS $$
DECLARE
  current_state text;
  current_expiry timestamptz;
  current_time timestamptz;
BEGIN
  IF requested_event_id IS NULL OR requested_token IS NULL
    OR lease_ms IS NULL OR lease_ms < 1 OR lease_ms > 300000 THEN
    RAISE EXCEPTION 'invalid acquire arguments';
  END IF;

  LOOP
    current_time := clock_timestamp();
    INSERT INTO chalk_webhook_inbox
      (event_id, state, lease_token, lease_expires_at)
    VALUES
      (requested_event_id, 'leased', requested_token,
       current_time + lease_ms * interval '1 millisecond')
    ON CONFLICT DO NOTHING;
    IF FOUND THEN
      RETURN QUERY SELECT 'acquired'::text, requested_token, NULL::integer;
      RETURN;
    END IF;

    SELECT inbox.state, inbox.lease_expires_at
      INTO current_state, current_expiry
      FROM chalk_webhook_inbox AS inbox
      WHERE inbox.event_id = requested_event_id
      FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE; -- A concurrent release won; retry the insert.
    END IF;
    current_time := clock_timestamp();
    IF current_state = 'completed' THEN
      RETURN QUERY SELECT 'completed'::text, NULL::uuid, NULL::integer;
      RETURN;
    END IF;
    IF current_expiry > current_time THEN
      RETURN QUERY SELECT 'busy'::text, NULL::uuid,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM current_expiry - current_time)))::integer;
      RETURN;
    END IF;

    UPDATE chalk_webhook_inbox
      SET lease_token = requested_token,
          lease_expires_at = current_time + lease_ms * interval '1 millisecond'
      WHERE event_id = requested_event_id;
    RETURN QUERY SELECT 'acquired'::text, requested_token, NULL::integer;
    RETURN;
  END LOOP;
END;
$$;
```

Call the function with a fresh random token for every attempt and map its single row directly to `WebhookInbox.acquire`. Completion and release stay fenced by that token:

```sql
-- complete: exactly one returned row is success; zero means this worker no
-- longer owns the lease and the adapter must reject completion.
UPDATE chalk_webhook_inbox
SET state = 'completed', lease_token = NULL,
    lease_expires_at = NULL, completed_at = clock_timestamp()
WHERE event_id = $1 AND state = 'leased' AND lease_token = $2
RETURNING event_id;

-- release: one returned row means released; zero is a safe no-op because a
-- newer lease or completion must never be removed by the former owner.
DELETE FROM chalk_webhook_inbox
WHERE event_id = $1 AND state = 'leased' AND lease_token = $2
RETURNING event_id;

-- Run this bounded cleanup repeatedly. It retains completion for at least 30 days.
WITH expired AS (
  SELECT event_id FROM chalk_webhook_inbox
  WHERE state = 'completed' AND completed_at < now() - interval '30 days'
  ORDER BY completed_at LIMIT 1000 FOR UPDATE SKIP LOCKED
)
DELETE FROM chalk_webhook_inbox AS inbox
USING expired WHERE inbox.event_id = expired.event_id;
```

If the complete statement returns zero rows, throw a content-free ownership error. If the database call itself has an uncertain outcome, don't release: completion may have committed before the connection failed, so a retry must discover `completed` or wait for the original lease to expire.

A Redis implementation should perform each transition in Lua so its state check and mutation remain atomic. Store one hash per Event; the acquire script takes the lease duration and a fresh token in `ARGV`, and uses Redis time so application clock skew cannot steal a lease:

```lua
-- acquire: ARGV[1] = lease milliseconds, ARGV[2] = fresh token
local lease_ms = tonumber(ARGV[1])
if not lease_ms or lease_ms < 1 or lease_ms > 300000 or ARGV[2] == '' then
  return redis.error_reply('invalid acquire arguments')
end
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'completed' then return {'completed'} end

local expires_at = tonumber(redis.call('HGET', KEYS[1], 'expires_at') or '0')
if state == 'leased' and expires_at > now then
  return {'busy', tostring(math.ceil((expires_at - now) / 1000))}
end

local new_expiry = now + lease_ms
redis.call('HSET', KEYS[1], 'state', 'leased', 'token', ARGV[2],
  'expires_at', new_expiry)
redis.call('PEXPIREAT', KEYS[1], new_expiry)
return {'acquired', ARGV[2]}
```

```lua
-- complete: ARGV[1] = owned token, ARGV[2] = retention milliseconds
local retention_ms = tonumber(ARGV[2])
if ARGV[1] == '' or not retention_ms or retention_ms < 2592000000 then
  return redis.error_reply('invalid complete arguments')
end
if redis.call('HGET', KEYS[1], 'state') ~= 'leased'
  or redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'state', 'completed')
redis.call('HDEL', KEYS[1], 'token', 'expires_at')
redis.call('PEXPIRE', KEYS[1], retention_ms)
return 1
```

```lua
-- release: ARGV[1] = owned token
if ARGV[1] == '' then return redis.error_reply('invalid release token') end
if redis.call('HGET', KEYS[1], 'state') ~= 'leased'
  or redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
```

Pass at least `2592000000` milliseconds—30 days—as the completion retention, with operational margin if cleanup timing is approximate. A complete result of `1` is success and `0` is stale ownership; a release result of `0` is a safe no-op. Treat a Redis timeout during complete as uncertain and leave the lease alone, just as with PostgreSQL. Redis eviction would erase deduplication state, so use persistence and an eviction policy suitable for this data.

## Understand the remaining duplicate window

The inbox prevents concurrent handling and remembers completed Events, but it cannot atomically commit an arbitrary external side effect with `complete`. If the process crashes after the side effect succeeds and before completion is recorded, Chalk retries after the lease expires and the handler runs again. Transact `event.id` with local database writes or pass it to a downstream API as its idempotency key; the SDK does not provide exactly-once effects.

An authenticated Event name unknown to this SDK is acknowledged with `200` and `outcome: "ignored"`. Verification failures return content-free safe results, and busy leases return `503` with bounded `Retry-After`. Every subscribed known Event needs a typed handler: a missing handler releases the lease and returns retryable `500` with `handler_missing`, while a handler failure releases it with `handler_failed`. Neither path marks the Event complete. Typed handlers are awaited and determine delivery success. `onUnknownEvent` and `onDiagnostic` are observational: their returned promises are not awaited, and synchronous throws or asynchronous rejections are ignored. Diagnostics contain only bounded phases, outcomes, duration, Event name, API version, and opaque IDs; they never export data by themselves.
