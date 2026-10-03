# Chalk tracker

Each entry is one product outcome: what exists today and the work left. Evidence and
verification logs live elsewhere. Priority is set by the owner.

Size is the work left. S is one focused change, M is several connected changes, L must
be split before starting, and Unknown needs investigation first.

Generated from tracker.yaml; run pnpm generate:tracker after editing it.

## Identity and Tenants

1. **Manage Tenant members and invitations** (Not started · size M · P1)
    The API can list members, add them and change their Role, but it has no invitations
    or removal. The People page is still a placeholder.
    - Add invitation (issue, accept, expire, revoke) and member removal to the API.
    - Build the People page on the existing and new operations.
    - Verify that denied Roles cannot change membership and that expired or revoked
      invitations show a way forward.

## Media

2. **Media works on real networks and devices** (Unclear · size M · P1)
    Web and native media are implemented, but every automated run uses mocked signaling.
    No two-party call has been checked on real browsers or physical phones.
    Open question: No real-network or physical-device observation exists.
    - Run a two-party call with audio, video, screen share, admission changes and
      reconnect on supported browsers and on iOS and Android release builds.
    - Cover permission denial, background return and media-route replacement.
    - Make an unmute after a moderator mute reach every receiver in under two seconds.
      In production it took about six seconds, and one receiver sometimes never hears
      it.
    - Find whether audio can play for a few tens of milliseconds after a muted badge
      when Sync restarts.
    - Check camera simulcast on physical Safari and phones; Firefox publishes one camera
      layer.

3. **Measure media usage per Tenant and Episode** (Not started · size M · P2)
    The Usage type has egress and Participant-minute fields, but both Cloudflare
    adapters always report zero, so media cost cannot be measured or limited.
    - Collect usage in both Cloudflare adapters and attribute it to Tenant and Episode.
    - Reconcile one live Episode against the provider bill, then expose usage to policy
      limits.

4. **Custom SFU** (Unclear · size XL · P1)
    Media runs only on Cloudflare SFU and RTK. A custom SFU removes that dependency. It
    is one task in two parts: the SFU itself, then its integration into Chalk.
    Open question: The SFU design and scope are not defined yet.
    - Part 1, the SFU: build the server that receives and forwards audio, video and
      screen share.
    - Part 2, the integration: add a MediaPlane adapter, web and native clients,
      credential renewal and Recording capture on top of it.

## Sync

5. **Sync survives node and database failure** (Partly working · size M · P1)
    Local checks cover repeated Sync restarts and chat queued during reconnects,
    alongside database outages and slow clients. Recovery on a production-like topology
    remains unqualified, and production has no database standby.
    Open question: The soak has only run on one machine with a local Postgres.
    - Run the fault soak against a named production-like topology, including the
      original database coming back after an outage.
    - Decide whether production needs a database standby once there are users.

6. **Reconnect heals on rocky networks** (Not started · size M)
    Clients rejoin after a page reload, hold offline actions, show a non-blocking
    reconnecting bar, and recover media in about 2.6 seconds after a 30-second cut. The
    owner's target is recovery as fast as possible on every path.
    - Confirm the reconnecting bar and its 10-second dialog with a real network cut in
      production.
    - Cut recovery further: restart ICE instead of rebuilding media, overlap SDP
      readiness, and get keyframes sooner after a cut.
    - Check with production reconnect telemetry whether Postgres restarts and flapping
      networks recover more slowly in their worst cases.
    - Re-record a self-mute that a Sync restart interrupted, so other Participants don't
      see the muted Participant as unmuted.

## Collaboration

7. **Whiteboard works across web and mobile** (Unclear · size S · P1)
    The whiteboard is wired into both the web and native Space, but no live Episode has
    used it across several clients or a phone.
    Open question: No live whiteboard Episode across clients has been observed.
    - Draw live web to web and web to phone, including view-only permission, file
      transfer, reconnect and snapshot recovery.
    - Check math, touch and keyboard input and viewport resizing.

8. **Keep whiteboard connections steady** (Unclear · size Unknown)
    Drawings survive reconnects, but the cause of unexpected whiteboard reconnects is
    not known.
    Open question: The reconnect trigger needs investigation before a fix can be scoped.
    - Reproduce an unexpected reconnect while drawing.
    - Find and fix the cause without weakening recovery after a real connection cut.
    - Confirm the board stays connected during normal drawing and sharing.

9. **Chat attachments stay isolated and get deleted** (Unclear · size S · P1)
    Upload, download, expiry and cleanup exist, but only local storage has been tested.
    Isolation between Tenants and real object deletion are unproved.
    Open question: Only local storage has been exercised.
    - Share an attachment between two authorized clients and check that another Tenant
      or Participant is refused.
    - Check that expired and abandoned uploads are deleted from real storage, cleanup
      survives interruption, and stale grants fail.

10. **Selectable sound packs** (Not started · size M · P3)
    Chalk has one set of sounds. There are no packs and no way for a Tenant to choose
    one.
    - Define packs and a Tenant setting, wire them into web and native events, and
      respect mute and accessibility settings.

## Recording

11. **Download a Recording as MP4** (Partly working · size S)
    Export renders an MP4 on request with the native compositor on an s-1vcpu-1gb worker
    in production. The file declares 30 fps while it plays at 15, and its first frame
    shows placeholders before the first video keyframes arrive.
    - Ship the 15 fps label and the first-frame fix.
    - Download one Export twice to confirm the second download reuses the file.

12. **Long Recordings stay in sync** (Not started · size Unknown)
    Capture bundles now share one recording clock, which fixed the skew that failed a
    332-second run. Senders whose clocks really drift apart are still unhandled.
    Open question: Whether the remaining drift comes from the headless sender or the
    recorder is not known.
    - Handle sender clock divergence and pass a one-hour Recording.
    - Prove recorder restart continuity and TLS peer rejection on the managed hosts.

13. **New Capture images boot in production** (Not started · size M)
    Production Capture runs on an image from 2026-10-02 because every Capture image
    built since then registers with the issuer but never asks for its certificate in the
    fleet. The same image completes a signed bootstrap on an isolated node, so the cause
    is in fleet provisioning.
    Open question: The failure has not reproduced outside the production fleet.
    - Keep a failing fleet node with its boot logs and creation payload before it is
      deleted.
    - Find and fix the cause, then move Capture to a current image.
    - Make image qualification and releases fail unless a new worker completes a
      fleet-style signed bootstrap and becomes ready.

14. **Capture starts fast and costs little** (Partly working · size M)
    Capture runs on the lean Debian image on s-1vcpu-1gb. A cold worker is ready about
    46 seconds after record, and anything said before it is ready is missing from the
    Recording. Automatic Spaces pre-warm Capture when someone opens the Entrance. SFU
    traffic to the recorder, about $90 a month at 2,000 hours, is now the largest
    Capture cost.
    Open question: Boot time is measured on few samples across DigitalOcean's variable
    create step. The owner chose pre-warm for Automatic Spaces only; Manual Spaces may
    want it later.
    - Experiment: with camera simulcast live, have Capture record the low camera layer
      and compare the Export and the SFU traffic to the recorder.
    - Experiment, only if UDP loss damages Recordings: compare Capture over TURN on TCP
      with UDP in one Recording. Cloudflare's SFU has no direct TCP receiver.

15. **Scheduled Recordings in a real integration** (Partly working · size M · P1)
    Scheduled preparation works in production: the 2026-09-20 canary started from a
    ready preparation. No first-party integration uses it yet, and reschedule, cancel,
    no-show and expiry have not run live.
    - Use the contract in a first-party integration and exercise reschedule, cancel,
      no-show and expiry live.

16. **Recordings and Transcripts on mobile** (Partly working · size M · P2)
    Mobile Participants with manageRecording can start and stop a Recording and see its
    status. There is no disclosure or consent step and no way to open the finished
    Recording or Transcript.
    - Add recording disclosure and consent.
    - Let authorized Participants open the finished Recording and Transcript.
    - Check denial, failed start or stop, background return and reconnect.

## Transcription

17. **Recordings produce a Transcript in production** (Partly working · size M · P1)
    The transcript-first pipeline and the direct DeepInfra adapter are built, and the
    production dispatcher is healthy. No production Recording has produced a Transcript
    yet: on 2026-09-23 audio preparation stalled after capture.
    Open question: The cause of the stall is not known.
    - Find and fix the audio preparation stall.
    - Produce a Transcript from a production Recording and check that only the right
      Tenant and Participants can read it.
    - Check that provider failure, retry, cancellation and Artifact Policy limits behave
      on the new path.

18. **Transcripts for mixed-language Recordings** (Not started · size M · P2)
    Whisper expects one language per Recording, so speech that switches between
    languages, such as Urdu and English or Arabic and English, transcribes badly. The
    hard part is finding a model that handles it at an acceptable cost.
    - Find a model that transcribes mixed-language speech well, and compare its cost
      with Whisper.
    - Choose how Recordings reach it: a per-Space or per-Recording model choice, or
      automatic routing that sends mixed-language audio to it and single-language audio
      to the cheaper model.

19. **Live captions in a Space** (Not started · size L · P3)
    Captions are off in Chalk and no live caption path exists. The Transcript panel only
    shows finished Transcripts.
    - Deliver live partial and final captions with consent, capability checks and
      cleanup.
    - Verify latency, reconnect, language handling and privacy.

## Security and compliance

20. **Tenant-set chat retention** (Not started · size M · P2)
    Tenants can set retention for Recordings and Transcripts but not for chat, and Sync
    has no chat purge.
    - Add chat retention to Tenant policy and purge expired messages and their
      attachments without breaking Sync recovery.
    - Check that hard delete overrides retention and purged messages never return
      through replay or snapshots.
    - Clear unsent offline chat held in browser storage when the Participant leaves or
      signs out, so it doesn't stay on a shared computer for up to 24 hours.

## SDK and embedding

21. **Published packages work in a fresh app** (Unclear · size S · P1)
    A packed-archive browser test covers recovery and attachments on three browsers
    against mocked signaling. Type consumption, a React Native release app and the
    server-only package are unchecked.
    Open question: No current packed-archive or native consumer result exists.
    - Record a current green packed-archive run.
    - Typecheck an independent consumer against the published declarations.
    - Build a React Native release app from the packages and check that server-only
      imports pull in no browser or native code.

22. **Same Chalk props on web and mobile** (Not started · size M · P1)
    Native Chalk lacks the recording and sounds features and four web props, and it
    names its feedback prop differently. The hooks already match.
    - Add the missing native features and props, or document each as an OS or rendering
      seam.
    - Unify the feedback prop and add a type check that fails when the two prop types
      drift.

23. **SDK app name in server telemetry** (Not started · size S · P1)
    No appName option exists on the client, SpaceClient, Chalk or AccessGrant request.
    - Add appName with the bounds from theory.md and carry it on HTTP and WebSocket
      requests into spans and logs.
    - Check omitted and oversized values and that appName never affects authorization.

24. **Every public endpoint is in the generated client** (Unclear · size S · P1)
    OpenAPI and the generated client cover integrations, API keys, status and
    attachments, but nobody has compared every public route against them.
    Open question: No full route comparison has been made.
    - Compare router.go against OpenAPI and the generated client, and mark internal
      routes as internal.
    - Call one Tenant-scoped integration route and one attachment route through the
      public client.

25. **Swift SDK** (Not started · size XL · P2)
    Only TypeScript SDKs exist.
    - Define the supported surface, generate or write the package, and ship it with an
      independent consumer build and contract fixtures.

26. **Kotlin SDK** (Not started · size XL · P2)
    Only TypeScript SDKs exist.
    - Define the supported surface, generate or write the package, and ship it with an
      independent consumer build and contract fixtures.

27. **Python SDK** (Not started · size XL · P2)
    Only TypeScript SDKs exist.
    - Define the supported surface, generate or write the package, and ship it with an
      independent consumer build and contract fixtures.

28. **Go SDK** (Not started · size XL · P2)
    Only TypeScript SDKs exist.
    - Define the supported surface, generate or write the package, and ship it with an
      independent consumer build and contract fixtures.

29. **Embed a Space in an iframe** (Not started · size L · P2)
    The SDK can be embedded, but there is no supported iframe contract for origins,
    access handoff or lifecycle messages.
    - Define the iframe entry, access handoff, allowed origins and lifecycle messages.
    - Check camera and microphone permission, resize, teardown and expired access from
      another origin.

## Integrations and webhooks

30. **Connect third-party apps in the dashboard** (Not started · size M · P2)
    The API can connect a Tenant to third-party apps through Composio, such as Gmail,
    Google Calendar, Drive, Docs and GitHub. The dashboard has no page to browse,
    connect or disconnect them.
    - Build a page to browse the app catalog, connect, refresh and disconnect an app,
      and show clear errors.
    - Require member permission and recent authentication for secrets, and show the
      audit records.

31. **Webhooks deliver and recover on a deployment** (Unclear · size S · P1)
    Signing, rotation and idempotency are implemented and unit-tested, but no deployed
    delivery or outage recovery has been observed.
    Open question: No deployed delivery has been observed.
    - Run a deployed canary through delivery, overlapping secret rotation, duplicate
      replay and a recipient outage, and check that each event takes effect exactly
      once.

## Operations

32. **Alerts fire and service recovers from failure** (Unclear · size M · P1)
    Production passes health checks, but no alert route has been tested and no failure
    has been injected and recovered from.
    Open question: No alert delivery or failure drill has been observed.
    - Inject one scoped service failure, confirm the alert and public status change,
      then recover and confirm healthy state.

33. **Customer-operated app tier runs** (Unclear · size M · P1)
    The API, Sync and Postgres are meant to run on a customer app tier, but no
    self-hosted revision has been deployed and validated.
    Open question: No self-hosted deployment has been observed.
    - Deploy a named revision on a customer-style app tier with a configured media
      adapter and pass validate-runtime and a web join.

34. **Join an Episode faster** (Not started · size M · P1)
    Seeing the other Participant takes about 4 seconds after clicking join. About 2
    seconds of that is Cloudflare SFU track setup and the browser handshake, which
    Chalk's code can't shorten; only starting them earlier can.
    Open question: No change has been tried, so the real saving is unknown.
    - Start the arrival request when the visitor shows intent to join, before the click.
    - Decide whether to open the Cloudflare SFU connection before the click, given
      consent and connection lifetime.
    - Time the API's Cloudflare SFU calls as their own spans so each join stage is
      visible.
    - Consider pushing chat message bodies over Sync instead of a head signal plus a
      fetch.

35. **Tests and gate catch real bugs** (Not started · size M)
    The gate passed while real media and reconnect bugs shipped, because tests fake
    Cloudflare SFU and the gate skips server checks for SDK-only changes. Many tests
    kill no mutation.
    - Run a broad mutation pass across the suite, then delete the tests that catch
      nothing.
    - Run a real Cloudflare SFU contract check on a schedule, covering disable and
      re-enable.
    - Stop SDK-only changes from skipping the server checks.
    - Keep the Sync, media and privacy soak harnesses runnable as scheduled checks
      rather than one-off scripts.

## Other products

36. **Run several local stacks at once** (Not started · size S)
    The local stack allows one runtime per machine, fixes its container and database
    names, and its stop command fails its own ownership check, so parallel agents
    collide.
    - Let the database, container names and owner lock vary per checkout.
    - Make stopping the stack work after a rebase or a supervisor restart.
    - Stop the local unused-code check from failing on untracked scratchpad scripts.

37. **Desktop app** (Not started · size XL · P3)
    No desktop app exists; the browser is the desktop surface.
    - Decide scope and distribution, then build with native integration, updates and a
      release proof.

38. **Bring your own agents** (Unclear · size XL · P3)
    People bring their own agents into a Space, as an assistant beside them or acting on
    their behalf. Agents can already join as Participants, but nothing lets a person
    bring, authorize or direct one.
    Open question: The agent product is not defined yet.
    - Define how a person brings an agent, what it may do alone or on their behalf, and
      how others see it.
    - Build the agent join, authority and consent flow on the existing Agent identity.

39. **Chalk MCP server** (Not started · size L · P3)
    Chalk has no MCP server, so AI tools cannot use Chalk directly.
    - Decide which Space, Episode, Recording and Transcript operations to expose, then
      ship an MCP server on the public API.
