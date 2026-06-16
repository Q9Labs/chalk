# Chalk Media Cost Model

Last checked: 2026-06-15.

## Baseline

- Usage: 180,000 room-min/month = 3,000 room-hours/month.
- Room shape: 3 participants.
- Audio: everyone receives everyone, Opus ~64 kbps.
- Video: active speaker only.
- Screenshare: low-res.
- Recording: always on.
- Avoid Cloudflare Stream minute-based recording.

## Formulas

- 1 Mbps for 1 hour ~= 0.45 GB.
- 3-person audio fanout: `3 * 2 * 0.064 Mbps = 0.384 Mbps`.
- Active speaker video fanout: `2 * active_video_mbps`.
- Screenshare fanout: `2 * screenshare_mbps`.
- Recorder subscriber input: `3 * 0.064 + active_video_mbps + screenshare_mbps`.
- Recorded file size: `recording_output_mbps * 3,000 * 0.45 GB`.

## Pricing Inputs

- Cloudflare Realtime SFU: first 1,000 GB/month free, then $0.05/GB egress to clients.
- Cloudflare R2 Standard: $0.015/GB-month, free internet egress.
- DigitalOcean Droplets: outbound transfer included by plan; overage $0.01/GiB; inbound free.
- DigitalOcean CPU-Optimized 2 vCPU / 4 GB: ~$42/month with 4,000 GiB transfer.

## Compiled Monthly Totals

Assume active-speaker video = 0.4 Mbps and screenshare = 0.4 Mbps.

### Cloudflare SFU Direct + Custom Recorder

Screenshare replaces active-speaker video:

- Estimated total: ~$110-$140/month.
- Cloudflare SFU live + recorder egress: ~$70/month.
- Recorder compute on DigitalOcean Singapore: ~$24-$42/month.
- R2 storage for 0.8-1.2 Mbps composite, 30-day retention: ~$16-$24/month.

Active-speaker video and screenshare visible together:

- Estimated total: ~$190-$220/month.
- Cloudflare SFU live + recorder egress: ~$151/month.
- Recorder compute on DigitalOcean Singapore: ~$24-$42/month.
- R2 storage for 0.8-1.2 Mbps composite, 30-day retention: ~$16-$24/month.

### DigitalOcean Singapore Self-Hosted SFU

Single-node SFU + local recorder:

- Estimated total: ~$60-$75/month.
- DigitalOcean CPU-Optimized 2 vCPU / 4 GB Droplet: ~$42/month with 4 TB transfer.
- Expected transfer overage: ~$0-$5/month in the working scenario.
- R2 storage for 0.8-1.2 Mbps composite, 30-day retention: ~$16-$24/month.

Safer two-node or small pool:

- Estimated total: ~$100-$115/month.
- DigitalOcean Droplets: ~$84/month.
- Expected transfer overage: ~$0-$5/month if transfer allowance pools cleanly.
- R2 storage for 0.8-1.2 Mbps composite, 30-day retention: ~$16-$24/month.

## Audit Details

Cloudflare SFU direct, active-speaker video and screenshare visible together:

- Live media egress: ~2.68 TB/month.
- Recorder as hidden subscriber receives: `0.192 + 0.4 + 0.4 = 0.992 Mbps`.
- Recorder extra SFU egress: ~1.34 TB/month.
- SFU cost with recorder: `max(0, 2678 + 1339 - 1000) * 0.05` ~= $151/month.

Cloudflare SFU direct, screenshare replaces active-speaker video:

- Live media egress: ~1.60 TB/month.
- Recorder subscriber input: `0.192 + 0.4 = 0.592 Mbps`.
- SFU cost with recorder: ~$70/month.

DigitalOcean Singapore self-hosted SFU:

- Run SFU plus recorder in Singapore.
- Live egress to clients, active video + screenshare: ~2.68 TB/month.
- Upload composite recordings to R2: ~1.08-1.62 TB/month.
- Total DigitalOcean outbound: ~3.76-4.30 TB/month.

## Current Read

- Cheapest: DigitalOcean Singapore self-hosted SFU + local recorder + R2 storage.
- Lower ops: Cloudflare SFU direct + custom recorder on DigitalOcean + R2 storage.
- Avoid: Cloudflare Stream minute-based storage for always-on meeting recordings.
- Biggest lever: do not show active-speaker video and screenshare simultaneously unless needed.
- Presentation preference: show compiled all-in monthly totals first, then put
  component breakdowns underneath. Avoid fragmented price tables that make the
  total hard to see.

## Sources

- Cloudflare SFU pricing: https://developers.cloudflare.com/realtime/sfu/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- DigitalOcean bandwidth billing: https://docs.digitalocean.com/platform/billing/bandwidth/
- DigitalOcean Droplet pricing: https://www.digitalocean.com/pricing/droplets
