# Chalk tracker

Each entry is remaining work that code cannot show. Delete an entry when its work is
done: the code is the record of what works. Priority is set by the owner.

Size is the work left. S is one focused change, M is several connected changes, L must
be split before starting, and Unknown needs investigation first.

Generated from tracker.yaml; run pnpm generate:tracker after editing it.

## Media

1. **Measure media usage per Tenant and Episode** (Not started · size M)
    The Usage type has egress and Participant-minute fields, but both the Cloudflare and
    Chalk SFU adapters return only metadata, so media cost cannot be measured or
    limited.
    - Collect usage in both adapters and attribute it to Tenant and Episode.
    - Expose usage to policy limits.

## Sync

2. **Numbered hands and named moderation** (Not started · size M)
    Raised hands are only a boolean, and the mute and stop events for microphone, camera
    and screen share carry only the target participant_id, not who acted. Each needs a
    Sync protocol field, so Sync ships before the SDKs.
    - Keep the order hands were raised in, and let a host lower someone else's hand.
    - Name the Participant who muted someone or stopped their camera or screen share.

## Transcription

3. **Live captions in a Space** (Not started · size L · P3)
    No live caption path exists. The Transcript panel only shows finished Transcripts.
    - Deliver live partial and final captions with consent, capability checks and
      cleanup.

## Security and compliance

4. **Tenant-set chat retention** (Not started · size M)
    Artifact Policy sets retention for Recordings and Transcripts only. Chat has no
    retention setting and no purge.
    - Add chat retention to Tenant policy and purge expired messages and their
      attachments without breaking Sync recovery.
    - Make sure hard delete overrides retention and purged messages never return through
      replay or snapshots.

## SDK and embedding

5. **SDK app name in server telemetry** (Not started · size S)
    The client, SpaceClient, Chalk and the AccessGrant request have no app name. Only
    the React Native CallKit options use an `appName`, for a different purpose.
    - Add a top-level `appName` and carry it on HTTP and WebSocket requests into API
      spans and logs. The server trims it, normalizes it to `[a-z0-9._-]`, caps it near
      64 characters and drops it when empty, because it becomes a metric and log
      dimension.
    - Never let `appName` affect authorization.

6. **SDKs beyond TypeScript** (Not started · size XL · P2)
    Only TypeScript SDKs exist. The OpenAPI contract is the input for Swift, Kotlin,
    Python and Go clients, and none is generated or published.
    - Per language: define the supported surface, generate or write the package, and
      ship it with an independent consumer build and contract fixtures.

7. **Embed a Space in an iframe** (Not started · size L)
    No supported iframe contract exists for origins, access handoff or lifecycle
    messages.
    - Define the iframe entry, access handoff, allowed origins and lifecycle messages.
    - Check camera and microphone permission, resize, teardown and expired access from
      another origin.
