# An Agent that joins a call

This document compares two ways to let a software Agent join a live Episode as a
participant that listens and speaks, and recommends one. Nothing here is built.
It also records what the MCP server can and cannot do for a call today, and what
diagnostics exist, so the next change starts from facts.

An Agent is the identity kind defined in [GLOSSARY.md](../GLOSSARY.md): a full
peer of a User with the same lifecycle and media rights. Bot, Assistant and AI are
not domain nouns, so this document says Agent.

## Recommendation

Build a headless SDK client that runs as its own worker service and joins as an
Agent through the normal admission path. Do not reuse the recorder for live
conversation: it can only listen, it needs an active recording, and its transcript
arrives after the call. Keep the recorder for what it already does, which is the
transcript an MCP client reads after the Episode (`inspect_transcripts`).

Before any build, run a one-day spike that answers the one open technical
question: can the SDK's media client run in Node with a WebRTC library passed in
through `peerConnectionFactory`, against both the own SFU and the Cloudflare SFU.
If it cannot, the fallback is the setup the proof kit already uses, headless
Chromium with fake media devices, which works but costs more per Agent.

## What exists today

**The MCP server can hand out the credentials but cannot be the participant.**
`chalk_control_call` (see [the MCP guide](mcp.md)) admits a participant, issues a
Sync token and issues a media access grant. A model that calls it receives
credentials, but a model in a chat loop cannot hold a WebRTC connection or a
Sync socket. The credentials must go to a worker process, never into the model's
context.

**Admission already accepts an identity.** The admit action takes `identity_id` or
`identity_external_id`, so an Agent registered as an identity can be admitted with a
role. Admission, the Sync token and the access grant all need `episodes:write`.
Tokens last five minutes, so the worker must renew them for a long call.

**The recorder listens but does not take part.** It is a Go worker built on Pion
(`apps/api/cmd/recorder-capture`) that pulls every track of an Episode through
six capture operations (`apps/api/internal/captureplane/types.go`). Those
operations only create, pull, renegotiate, inspect and close; none publishes media,
and the worker is not a roster participant. It runs
on a DigitalOcean `c-2` node at one Episode per node. Output is encrypted capture,
a rendered MP4 and a Whisper transcript after the call, made from each participant's microphone audio, not from the MP4. Shared tab audio is
excluded from recordings.

**The SDK can run without a browser media stack.** The media client takes an
optional `peerConnectionFactory` (`sdks/typescript/client/src/media/client.ts`),
and the React Native SDK already supplies a native one. This is the seam a Node
WebRTC library would use. It has not been tried in Node.

**A headless call client already exists in practice.** The proof kit
(`scripts/prod-proof`) joins calls with Playwright and headless Chromium. It proves
the SDK works without a person, but one browser per Agent is heavy.

**Server-side SDK clients have no session id.** Diagnostics tie to a browser tab or
app launch ([observability](observability.md)), so an Agent worker needs its own
session identity before its calls can be followed.

## Option A: reuse the recorder

| Question      | Answer                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| What it hears | Every microphone and camera track, from a server-side pull. It does not hear shared tab audio.                                     |
| What it says  | Nothing. The capture plane has no publish operation.                                                                               |
| Latency       | Minutes after the call. The transcript is made from each participant's microphone audio after render.                              |
| Cost          | About $0.238 per recorded hour (capture $0.0625, render $0.146, Whisper $0.03), from [the cost model](recording-transcription.md). |
| Main risk     | It needs an active recording, so every participant is recorded to give the Agent ears.                                             |

Option A fits a post-call summariser. It does not fit a participant.

## Option B: headless SDK client (recommended)

| Question      | Answer                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it hears | The remote audio tracks it subscribes to, in real time. It should subscribe to audio only: the worker reports every remote tile as hidden with `setVideoTileVisibility(publicationId, null)`, and the SDK then stops pulling that video and keeps the audio.                                                                             |
| What it says  | A synthetic audio track published from synthesized speech, plus Sync messages (chat, hand raise) as any participant sends them.                                                                                                                                                                                                          |
| Latency       | Real time. The speed of the speech-to-text, model and speech-synthesis loop decides the delay, not Chalk.                                                                                                                                                                                                                                |
| Cost          | Not measured. Three parts: the worker (a Node process, or Chromium at roughly half a `c-2` node, about $0.03 per hour, an estimate to measure in the spike), the SFU packets for the audio it subscribes to, and the vendor price of speech-to-text, model and speech-synthesis. Take vendor prices at build time; none is assumed here. |
| Main risk     | The Node WebRTC library is unproven against Chalk's SFUs.                                                                                                                                                                                                                                                                                |

The worker owns the connection. A separate service (not `apps/api`) holds the
tenant API key, calls the three admission steps, keeps the tokens fresh, runs the
speech loop and leaves when the Episode ends or the idle limit passes. The model
sees text only.

## Risks and the limits that answer them

1. **Credentials in the model's context.** The worker, not the model, calls
   `chalk_control_call` or the REST routes. The MCP tool stays for operators who
   want to admit a person.
2. **Prompt injection from the call.** Transcripts and chat are untrusted text from
   other people. The Agent's tools must be read-only unless a human grants more,
   and every transcript read keeps the untrusted label the MCP server already adds.
3. **Surprise.** People in the call must see that an Agent is present. Admit it with
   a visible name and a role that cannot record, remove people or change settings;
   the role is the limit, because an Agent has the same rights as a User by default.
4. **Cost without a ceiling.** Set a maximum Agent duration per Episode, an idle
   leave, and one Agent per Episode in the first version. The Episode already caps
   active participants at 500; the Agent counts toward that.
5. **Echo and talking over people.** The Agent needs voice activity detection and
   must stop speaking when a person starts. This is the main product risk and needs
   a real call to judge.
6. **Audit.** Every admission already logs `mcp.call_credentials.requested` with the
   actor, Episode and outcome. The worker must log its own join and leave with the
   same Episode and identity ids.

## Plan

1. Spike (one day): join a live Episode of a test Space from Node with an injected WebRTC library,
   subscribe to one audio track, publish one tone, and record CPU and memory on the
   own SFU and the Cloudflare SFU. Stop here if it fails, and decide on Chromium.
2. Worker: admission, token renewal, subscribe to audio, speech loop, leave rules.
3. Product: an Agent identity registered per tenant, a role with no management
   rights, and a visible Agent label in the roster.

## Mute everyone

Muting every participant is not available through MCP. It is a Sync socket command
(`mute_participant`, and `muteOthers` in the SDK), and Sync commands need a live
participant connection, not a tenant API key. The MCP server skips it. An Agent
worker that holds a moderator role could send it, which is another reason to keep
that role off by default.

## Diagnostics

Three routes carry diagnostics today, and all three need a participant media token,
not a tenant API key:

| Route                                             | Where it goes                                                                                                                                | Stored per tenant |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `POST /v1/tenants/{tenant_id}/problem-reports`    | Sent to Discord by the problem-report service (`apps/api/internal/problemreports`); the request returns an outcome such as `discord_failed`. | No                |
| `POST /v1/tenants/{tenant_id}/call-stats`         | Structured log lines only (`apps/api/internal/httpapi/call_stats.go`).                                                                       | No                |
| `POST /v1/tenants/{tenant_id}/connection-reports` | Warning or info log lines only (`apps/api/internal/httpapi/connection_reports.go`).                                                          | No                |

So a tenant cannot read its own diagnostics, and an MCP tool has nothing to read.
A read surface would need, in this order:

1. A decision on where the data lives: a Postgres table keyed by tenant, Episode and
   participant with a short retention, or a query over the log store. Postgres gives
   tenant isolation and a bounded result; logs give no new storage but no tenant
   guarantee.
2. Redaction rules, because these records hold user agents and network details.
3. A derived permission such as `diagnostics:read`, following the way
   `tenants:settings:read` and `episodes:credentials:issue` are derived for API keys.
4. A bounded `inspect_diagnostics` view on the existing inspect tool, with the
   same 64 KiB result limit.

No storage is built. This section is the whole answer to the request.

## Not verified

- Whether a Node WebRTC library works with Chalk's SFUs (the spike).
- The cost of the worker, the speech loop and the SFU packets for one Agent.
- Whether an Agent identity can be registered today with a role that excludes
  recording and moderation; the admit path accepts an identity, but no Agent
  registration flow was exercised.
