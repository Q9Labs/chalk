# Chalk Media Cost Model

Last checked: 2026-06-15.

This model is parametric. Plug your own usage, room shape, and pricing into the
placeholders below. For a live version, open
[`chalk-cost-calculator.html`](./chalk-cost-calculator.html) in a browser.

## Inputs

### Usage

- `room_minutes_per_month` — total room-minutes across all meetings.
- `room_hours = room_minutes_per_month / 60`.

### Room shape

- `participants` — average people per room.
- `audio_mbps` — per-participant audio bitrate (Opus ~0.064 Mbps).
- `active_video_mbps` — active-speaker video bitrate (0 to disable).
- `screenshare_mbps` — screenshare bitrate (0 to disable).
- `simultaneous` — whether active-speaker video and screenshare are sent at the
  same time. If false, screenshare replaces active-speaker video.

### Recording

- `recording_on` — whether a hidden recorder subscribes to the room.
- `retention_days` — how long composite recordings are kept.

### Pricing

- `sfu_free_gb` — free SFU egress per month (Cloudflare: 1,000 GB).
- `sfu_per_gb` — SFU egress price beyond the free pool (Cloudflare: $0.05/GB).
- `r2_per_gb_month` — object storage price (Cloudflare R2: $0.015/GB-month).
- `droplet_base` — self-hosted node base price (DO 2 vCPU / 4 GB: ~$42/month).
- `transfer_included_gib` — transfer included with the node (DO: ~4,000 GiB).
- `transfer_overage_per_gib` — overage price (DO: $0.01/GiB).

## Formulas

Bandwidth-to-storage conversion: `1 Mbps for 1 hour ~= 0.45 GB`.

### Per-room egress (Mbps)

- `video_mbps = simultaneous ? active_video_mbps + screenshare_mbps : max(active_video_mbps, screenshare_mbps)`
- `audio_fanout = participants * (participants - 1) * audio_mbps`
- `media_fanout = (participants - 1) * video_mbps`
- `live_egress_mbps = audio_fanout + media_fanout`

### Recorder

- `recorder_input_mbps = recording_on ? (participants * audio_mbps + video_mbps) : 0`
- `recording_output_mbps = recorder_input_mbps`

### Monthly volumes (GB)

- `live_egress_gb = live_egress_mbps * room_hours * 0.45`
- `recorder_egress_gb = recorder_input_mbps * room_hours * 0.45`
- `recorded_gb = recording_output_mbps * room_hours * 0.45`
- `stored_gb = recorded_gb * (retention_days / 30)`

### Costs

Cloudflare SFU direct + custom recorder:

- `sfu_billable_gb = max(0, live_egress_gb + recorder_egress_gb - sfu_free_gb)`
- `sfu_cost = sfu_billable_gb * sfu_per_gb`
- `r2_cost = stored_gb * r2_per_gb_month`
- `recorder_compute` — fixed node cost for the recorder (`droplet_base` range).
- `total = sfu_cost + r2_cost + recorder_compute`

Self-hosted SFU on a node (DigitalOcean):

- `node_outbound_gib = (live_egress_gb + recorded_gb) / 1.073` (GB to GiB)
- `transfer_overage = max(0, node_outbound_gib - transfer_included_gib) * transfer_overage_per_gib`
- `total = droplet_base + transfer_overage + r2_cost`

## Reference scenario

Defaults that reproduce the prior baseline:

- `room_minutes_per_month = 180,000` (3,000 room-hours).
- `participants = 3`, `audio_mbps = 0.064`.
- `active_video_mbps = 0.4`, `screenshare_mbps = 0.4`.
- `recording_on = true`, `retention_days = 30`.

This lands Cloudflare SFU direct around $110-$220/month depending on
`simultaneous`, and self-hosted DO around $60-$115/month.

## Current Read

- Cheapest: self-hosted SFU + local recorder + R2 storage.
- Lower ops: Cloudflare SFU direct + custom recorder on a node + R2 storage.
- Avoid: Cloudflare Stream minute-based storage for always-on recordings.
- Biggest lever: keep `simultaneous = false` unless active video and screenshare
  truly need to be shown together.
- Presentation preference: show the compiled all-in monthly total first, then the
  component breakdown underneath.

## Sources

- Cloudflare SFU pricing: https://developers.cloudflare.com/realtime/sfu/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- DigitalOcean bandwidth billing: https://docs.digitalocean.com/platform/billing/bandwidth/
- DigitalOcean Droplet pricing: https://www.digitalocean.com/pricing/droplets
