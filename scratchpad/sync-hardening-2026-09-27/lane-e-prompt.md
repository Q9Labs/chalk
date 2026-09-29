# Lane E: SFU options for Pakistan and the Middle East

Chalk is an OSS real-time collaboration product (read theory.md and GLOSSARY.md). Its media plane is meant to be replaceable: a MediaPlane adapter owns provider details and the domain stays Space, Episode, Participant. Today the only adapter is Cloudflare Realtime SFU. Target users are in Pakistan and the Middle East (UAE, Oman, Saudi Arabia); the owner is in Karachi. Measurements show Cloudflare Realtime's control API is slow and flaky from Karachi (p50 1.7s, p95 9.5s, 503s, 10s timeouts); another lane is confirming that. The owner is considering another SFU provider or running their own SFU, in Singapore or in several locations.

Research and produce a decision-ready comparison. Use web sources from 2024–2026 and cite them.

1. Candidates: managed (LiveKit Cloud, Cloudflare Realtime, Daily, Agora, Twilio if still offered, 100ms, Dyte/Cloudflare, others relevant in 2026) and self-hosted (LiveKit OSS, mediasoup, Janus, Jitsi Videobridge, Pion-based options). For each: points of presence or regions near Karachi, Dubai, Muscat, Riyadh, Mumbai, Singapore; pricing model and a cost estimate for 1,000 and 10,000 Participant-hours per month of a 4-person Space with 720p video; control-plane latency design (is signaling regional or centralized?); multi-region cascading support; recording/egress support; licence; operational burden.
2. Self-hosting locations: cloud regions in or near the target area (AWS me-central-1 UAE, me-south-1 Bahrain, AWS/GCP/Azure/Oracle regions in Saudi Arabia, Qatar, UAE, Mumbai, Singapore; DigitalOcean, Hetzner, Vultr, OVH in Singapore/Mumbai/Middle East), with egress prices per GB and typical RTT from Karachi, Dubai, Riyadh, Muscat (cite measured RTT sources such as WonderNetwork or cloud ping tables). Note data-residency rules for Saudi Arabia and UAE if relevant.
3. Fit with Chalk: read sdks/typescript/client/src/media/ and apps/api/internal/adapters/cloudflare/sfu/ and the recording capture code in apps/api/internal/capture* and apps/api/internal/recorder* to list which Cloudflare-specific assumptions an alternative adapter would need to replace (signaling shape, track naming, publication/pull model, TURN, recording capture). Estimate the size of adding one alternative adapter.
4. Recommendation: at most two options worth a hands-on trial, with the trial you would run to decide (what to measure, from where, pass/fail thresholds).

Web research and reading code only: do not sign up for services or spend money.

Done: write lane-e-report.md in the lane folder.
