<!-- image:  -->

<!-- whats-new -->
## Features

- **Improved meeting reliability for schools and teams** — internal sessions can now be opened through dedicated share and callback pages for smoother room transitions.
- **Shareable diagnostics and logs** — teachers and support teams can access log files from native apps and share them when troubleshooting.
- **Internal team workflows expanded** — organizations can use internal sign-in and dashboard pages for room and recording operations.
- **Room and recording links made easier to manage** — host-only joins and share links support safer controlled access flows.

## Improvements

- **Mobile and desktop audio feels more consistent** — app behavior recovers better after browser autoplay restrictions.
- **System health and capacity visibility improved** — more direct signals from dashboards, web socket health, and worker metrics are now available.
- **Build and development flow simplified** — native scripts cover common run and install flows for iOS and Android.

## Bug Fixes

- **Meeting joins and recordings are more stable** after resilience and timeout updates.
- **Session and websocket stability improved** by reducing noise from expected disconnects.
- **Capacity planning data is captured automatically** during stress tests so regressions are easier to spot.

## Technical Notes

- API: expanded internal tenant schema and internal auth + dashboard endpoints for hosted workflows.
- API: added opaque join token exchange and public recording-share endpoints.
- API: switched join/meeting participant flow to reduce latency and harden retries.
- API: improved websocket observability and split-brain diagnostics.
- SDK-React: added handling for autoplay restrictions and media API edge cases.
- SDK-React Native and SDK core: prepared for updated native and web stability paths.
- Whiteboard: removed in-room tool-calling overlay route.
- Infra: added whisper/capacity and cloudflare/websocket dashboards/alarms; expanded observability for RTF and GPU utilization.
- CI: updated infrastructure plan/apply artifact handoff and disabled API golangci-lint in pipeline.
- Whisper Worker: improved throughput/queue metrics and transcription timeout handling.
- Stress testing: recorded infra snapshot stream for ECS/ALB/Aurora/Redis across VU steps.
<!-- /whats-new -->
