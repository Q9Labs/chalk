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
    A local fault soak kills Sync right after an acknowledgement, restarts and stops
    Postgres, and slows a client. It has not been run on a production-like topology, and
    production runs a single database node with no standby.
    Open question: The soak has only run on one machine with a local Postgres.
    - Run the fault soak against a named production-like topology, including the
      original database coming back after an outage.
    - Decide whether production needs a database standby once there are users.

6. **Reconnect heals on rocky networks** (Not started · size M)
    Clients reconnect after Sync restarts and short drops, but reconnection hasn't been
    designed as one self-healing path across Sync, media and the page.
    - Agree a target for recovery time after a drop, a flapping network, a Sync or API
      restart, and a page reload.
    - Close the gaps between today's behavior and that target.
    - Make a page reload during an Episode rejoin it without a second click, if the
      owner wants that.

## Collaboration

7. **Whiteboard works across web and mobile** (Unclear · size S · P1)
    The whiteboard is wired into both the web and native Space, but no live Episode has
    used it across several clients or a phone.
    Open question: No live whiteboard Episode across clients has been observed.
    - Draw live web to web and web to phone, including view-only permission, file
      transfer, reconnect and snapshot recovery.
    - Check math, touch and keyboard input and viewport resizing.

8. **Chat attachments stay isolated and get deleted** (Unclear · size S · P1)
    Upload, download, expiry and cleanup exist, but only local storage has been tested.
    Isolation between Tenants and real object deletion are unproved.
    Open question: Only local storage has been exercised.
    - Share an attachment between two authorized clients and check that another Tenant
      or Participant is refused.
    - Check that expired and abandoned uploads are deleted from real storage, cleanup
      survives interruption, and stale grants fail.

9. **Selectable sound packs** (Not started · size M · P3)
    Chalk has one set of sounds. There are no packs and no way for a Tenant to choose
    one.
    - Define packs and a Tenant setting, wire them into web and native events, and
      respect mute and accessibility settings.

## Recording

10. **Download a Recording as MP4** (Partly working · size S)
    Managed production produced a verified MP4 on 2026-09-20, when video rendered after
    every Recording. The code now renders an MP4 only on request, with a fourteen-hour
    limit, and that flow is not deployed.
    - Deploy on-request Export, request one Export end to end, and download it twice to
      confirm the second download reuses the file.

11. **Long Recordings stay in sync** (Not started · size Unknown)
    Capture bundles now share one recording clock, which fixed the skew that failed a
    332-second run. Senders whose clocks really drift apart are still unhandled.
    Open question: Whether the remaining drift comes from the headless sender or the
    recorder is not known.
    - Handle sender clock divergence and pass a one-hour Recording.
    - Prove recorder restart continuity and TLS peer rejection on the managed hosts.

12. **Capture starts fast and costs little** (Partly working · size L)
    A Capture worker takes about 140 seconds from record to ready and runs on a c-2 with
    a 1.6 GB image shared with Render. At 2,000 meeting-hours a month, Capture costs
    about $230, of which about $131 is Droplets and about $90 is SFU traffic to the
    recorder.
    Open question: Whether a smaller image shortens DigitalOcean's roughly 30-second
    create step is not measured.
    - Turn off DigitalOcean's monitoring and console agents at create, push Capture
      demand to the fleet controller, and have the worker log its own CPU and memory.
    - Build separate lean Capture and Render images on a minimal OS base.
    - Move Capture to the smallest Droplet size its measured CPU and memory allow.
    - Experiment: record a lower simulcast layer of each camera (for example 360p) and
      compare the Export and the SFU traffic to the recorder.
    - Experiment: if Cloudflare's SFU accepts a TCP receiver, have the recorder receive
      over TCP and compare gaps and loss-driven keyframes against UDP.

13. **Scheduled Recordings in a real integration** (Partly working · size M · P1)
    Scheduled preparation works in production: the 2026-09-20 canary started from a
    ready preparation. No first-party integration uses it yet, and reschedule, cancel,
    no-show and expiry have not run live.
    - Use the contract in a first-party integration and exercise reschedule, cancel,
      no-show and expiry live.

14. **Recordings and Transcripts on mobile** (Partly working · size M · P2)
    Mobile Participants with manageRecording can start and stop a Recording and see its
    status. There is no disclosure or consent step and no way to open the finished
    Recording or Transcript.
    - Add recording disclosure and consent.
    - Let authorized Participants open the finished Recording and Transcript.
    - Check denial, failed start or stop, background return and reconnect.

## Transcription

15. **Recordings produce a Transcript in production** (Partly working · size M · P1)
    The transcript-first pipeline and the direct DeepInfra adapter are built, and the
    production dispatcher is healthy. No production Recording has produced a Transcript
    yet: on 2026-09-23 audio preparation stalled after capture.
    Open question: The cause of the stall is not known.
    - Find and fix the audio preparation stall.
    - Produce a Transcript from a production Recording and check that only the right
      Tenant and Participants can read it.
    - Check that provider failure, retry, cancellation and Artifact Policy limits behave
      on the new path.

16. **Transcripts for mixed-language Recordings** (Not started · size M · P2)
    Whisper expects one language per Recording, so speech that switches between
    languages, such as Urdu and English or Arabic and English, transcribes badly. The
    hard part is finding a model that handles it at an acceptable cost.
    - Find a model that transcribes mixed-language speech well, and compare its cost
      with Whisper.
    - Choose how Recordings reach it: a per-Space or per-Recording model choice, or
      automatic routing that sends mixed-language audio to it and single-language audio
      to the cheaper model.

17. **Live captions in a Space** (Not started · size L · P3)
    Captions are off in Chalk and no live caption path exists. The Transcript panel only
    shows finished Transcripts.
    - Deliver live partial and final captions with consent, capability checks and
      cleanup.
    - Verify latency, reconnect, language handling and privacy.

## Security and compliance

18. **Tenant-set chat retention** (Not started · size M · P2)
    Tenants can set retention for Recordings and Transcripts but not for chat, and Sync
    has no chat purge.
    - Add chat retention to Tenant policy and purge expired messages and their
      attachments without breaking Sync recovery.
    - Check that hard delete overrides retention and purged messages never return
      through replay or snapshots.

## SDK and embedding

19. **Published packages work in a fresh app** (Unclear · size S · P1)
    A packed-archive browser test covers recovery and attachments on three browsers
    against mocked signaling. Type consumption, a React Native release app and the
    server-only package are unchecked.
    Open question: No current packed-archive or native consumer result exists.
    - Record a current green packed-archive run.
    - Typecheck an independent consumer against the published declarations.
    - Build a React Native release app from the packages and check that server-only
      imports pull in no browser or native code.

20. **Same Chalk props on web and mobile** (Not started · size M · P1)
    Native Chalk lacks the recording and sounds features and four web props, and it
    names its feedback prop differently. The hooks already match.
    - Add the missing native features and props, or document each as an OS or rendering
      seam.
    - Unify the feedback prop and add a type check that fails when the two prop types
      drift.

21. **SDK app name in server telemetry** (Not started · size S · P1)
    No appName option exists on the client, SpaceClient, Chalk or AccessGrant request.
    - Add appName with the bounds from theory.md and carry it on HTTP and WebSocket
      requests into spans and logs.
    - Check omitted and oversized values and that appName never affects authorization.

22. **Every public endpoint is in the generated client** (Unclear · size S · P1)
    OpenAPI and the generated client cover integrations, API keys, status and
    attachments, but nobody has compared every public route against them.
    Open question: No full route comparison has been made.
    - Compare router.go against OpenAPI and the generated client, and mark internal
      routes as internal.
    - Call one Tenant-scoped integration route and one attachment route through the
      public client.

23. **Swift SDK** (Not started · size XL · P2)
    Only TypeScript SDKs exist.
    - Define the supported surface, generate or write the package, and ship it with an
      independent consumer build and contract fixtures.

24. **Kotlin SDK** (Not started · size XL · P2)
    Only TypeScript SDKs exist.
    - Define the supported surface, generate or write the package, and ship it with an
      independent consumer build and contract fixtures.

25. **Python SDK** (Not started · size XL · P2)
    Only TypeScript SDKs exist.
    - Define the supported surface, generate or write the package, and ship it with an
      independent consumer build and contract fixtures.

26. **Go SDK** (Not started · size XL · P2)
    Only TypeScript SDKs exist.
    - Define the supported surface, generate or write the package, and ship it with an
      independent consumer build and contract fixtures.

27. **Embed a Space in an iframe** (Not started · size L · P2)
    The SDK can be embedded, but there is no supported iframe contract for origins,
    access handoff or lifecycle messages.
    - Define the iframe entry, access handoff, allowed origins and lifecycle messages.
    - Check camera and microphone permission, resize, teardown and expired access from
      another origin.

## Integrations and webhooks

28. **Connect third-party apps in the dashboard** (Not started · size M · P2)
    The API can connect a Tenant to third-party apps through Composio, such as Gmail,
    Google Calendar, Drive, Docs and GitHub. The dashboard has no page to browse,
    connect or disconnect them.
    - Build a page to browse the app catalog, connect, refresh and disconnect an app,
      and show clear errors.
    - Require member permission and recent authentication for secrets, and show the
      audit records.

29. **Webhooks deliver and recover on a deployment** (Unclear · size S · P1)
    Signing, rotation and idempotency are implemented and unit-tested, but no deployed
    delivery or outage recovery has been observed.
    Open question: No deployed delivery has been observed.
    - Run a deployed canary through delivery, overlapping secret rotation, duplicate
      replay and a recipient outage, and check that each event takes effect exactly
      once.

## Operations

30. **Alerts fire and service recovers from failure** (Unclear · size M · P1)
    Production passes health checks, but no alert route has been tested and no failure
    has been injected and recovered from.
    Open question: No alert delivery or failure drill has been observed.
    - Inject one scoped service failure, confirm the alert and public status change,
      then recover and confirm healthy state.

31. **Customer-operated app tier runs** (Unclear · size M · P1)
    The API, Sync and Postgres are meant to run on a customer app tier, but no
    self-hosted revision has been deployed and validated.
    Open question: No self-hosted deployment has been observed.
    - Deploy a named revision on a customer-style app tier with a configured media
      adapter and pass validate-runtime and a web join.

32. **Join an Episode faster** (Not started · size M · P1)
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

33. **Tests and gate catch real bugs** (Not started · size M)
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

34. **Run several local stacks at once** (Not started · size S)
    The local stack allows one runtime per machine, fixes its container and database
    names, and its stop command fails its own ownership check, so parallel agents
    collide.
    - Let the database, container names and owner lock vary per checkout.
    - Make stopping the stack work after a rebase or a supervisor restart.
    - Stop the local unused-code check from failing on untracked scratchpad scripts.

35. **Desktop app** (Not started · size XL · P3)
    No desktop app exists; the browser is the desktop surface.
    - Decide scope and distribution, then build with native integration, updates and a
      release proof.

36. **Bring your own agents** (Unclear · size XL · P3)
    People bring their own agents into a Space, as an assistant beside them or acting on
    their behalf. Agents can already join as Participants, but nothing lets a person
    bring, authorize or direct one.
    Open question: The agent product is not defined yet.
    - Define how a person brings an agent, what it may do alone or on their behalf, and
      how others see it.
    - Build the agent join, authority and consent flow on the existing Agent identity.

37. **Chalk MCP server** (Not started · size L · P3)
    Chalk has no MCP server, so AI tools cannot use Chalk directly.
    - Decide which Space, Episode, Recording and Transcript operations to expose, then
      ship an MCP server on the public API.
