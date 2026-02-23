# Control-Plane Cost Baseline (Lean)

Last updated: 2026-02-23

## Scope

Control-plane only. Excludes media usage charges (RealtimeKit/SFU usage, egress, etc).

## Fixed Baseline Targets

- EC2 `t4g.micro`: low single-digit monthly baseline in us-east-1.
- PlanetScale Postgres: lowest paid tier at launch.
- Upstash Redis: free tier at launch, auto-upgrade by threshold.
- Cloudflare R2: usage-based (recordings/object storage).
- CloudWatch: minimal alarms only.

## Formulas

- `participant_minutes = sessions * avg_minutes * avg_participants`
- RealtimeKit A/V: `participant_minutes * 0.002`
- RealtimeKit audio-only: `participant_minutes * 0.0005`
- SFU GB estimate: `participant_minutes * avg_downlink_mbps * 0.0075`
- SFU cost: `max(0, sfu_gb - 1000) * 0.05`

## Upgrade Triggers

- Upstash free -> paid:
  - forecasted monthly usage >80% free cap, or
  - sustained p95 Redis latency/SLO breaches.
- EC2 `micro -> small`:
  - sustained CPU >70% with memory pressure/restarts.
- PlanetScale tier bump:
  - sustained connection pressure, query p95 regression, or CPU/storage thresholds.

## Notes

- Keep this file synced with live provider pricing pages before major customer onboarding.
- Keep a monthly before/after snapshot after each infra resize.
