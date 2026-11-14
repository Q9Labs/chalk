# An Agent that joins a call

Decision: an Agent that listens and speaks in a live Episode is a headless SDK
client in its own worker service, admitted through the normal admission path. It
is not the recorder. Nothing here is built.

An Agent is the identity kind in [GLOSSARY.md](../GLOSSARY.md): a full peer of a
User with the same lifecycle and media rights. Bot, Assistant and AI are not
domain nouns.

## Why not the recorder

The recorder (`apps/api/cmd/recorder-capture`) only pulls tracks. The capture
plane has no publish operation, it is not a roster participant, it needs an
active recording (so every participant would be recorded to give the Agent ears),
and its transcript arrives after the call. Keep it for post-call transcripts that
an MCP client reads with `inspect_transcripts`.

## Why a headless SDK client

- Admission already accepts an identity (`identity_id` or
  `identity_external_id`) with a role, so an Agent can be admitted like anyone.
- The media client takes an optional `peerConnectionFactory`
  (`sdks/typescript/client/src/media/client.ts`), and the React Native SDK already
  supplies a native one. A Node WebRTC library would use the same seam.
- It hears remote audio in real time. Subscribe to audio only by reporting every
  remote tile hidden with `setVideoTileVisibility(publicationId, null)`.
- It speaks by publishing a synthetic audio track, and sends Sync messages as any
  participant does. Latency is the speech-to-text, model and synthesis loop, not
  Chalk.

The MCP server can hand out the credentials (`chalk_control_call`, see
[the MCP guide](mcp.md)) but cannot be the participant: a model in a chat loop
cannot hold a WebRTC or Sync connection. A separate worker holds the tenant API
key, calls the admission steps, renews the five-minute tokens, runs the speech
loop and leaves when the Episode ends or an idle limit passes. The model sees
text only.

## Open question

Whether the SDK media client runs in Node with an injected WebRTC library against
both the Chalk SFU and the Cloudflare SFU is unproven. Answer it with a one-day
spike (join, subscribe to one audio track, publish one tone, record CPU and
memory) before building. The fallback is headless Chromium with fake media
devices, as `scripts/prod-proof` already does. It works but costs more per Agent.
Worker cost, vendor prices and whether an Agent identity can be registered with a
role that excludes recording and moderation are also unmeasured.

## Risks and the limits that answer them

1. **Credentials in the model's context.** The worker, not the model, calls the
   admission routes.
2. **Prompt injection from the call.** Transcripts and chat are untrusted text.
   Agent tools stay read-only unless a human grants more.
3. **Surprise.** People must see an Agent is present: a visible name and a role
   that cannot record, remove people or change settings. The role is the limit,
   because an Agent has User rights by default.
4. **Cost without a ceiling.** Cap Agent duration per Episode, leave when idle, and
   allow one Agent per Episode at first. It counts toward the Episode's active
   participant cap.
5. **Talking over people.** The Agent needs voice activity detection and must stop
   when a person starts. This needs a real call to judge.
6. **Audit.** Admission already logs `mcp.call_credentials.requested`. The worker
   logs its own join and leave with the same Episode and identity ids. Server-side
   SDK clients have no session id yet, so the worker needs its own before its
   calls can be followed ([observability](observability.md)).

## Diagnostics are write-only

The problem-report, call-stats and connection-report routes need a participant
media token and are not stored per tenant, so an MCP tool has nothing to read. A
read surface needs a storage decision first (a tenant-keyed Postgres table with
short retention gives isolation; logs give none), then redaction, a derived
`diagnostics:read` permission and a bounded `inspect_diagnostics` view.
