---
name: chalk-tenant-bootstrap
description: Create and configure Chalk tenants quickly (limits, allowed origins, post-meeting webhook, whsec) via public API.
---

# Chalk Tenant Bootstrap Skill

Goal: create + configure tenants fast, repeatable, low-risk.

## Use when

- DB wiped / environment reset.
- Need to recreate standard tenant set.
- Need API keys + webhook secrets table output.

## Script

- `scripts/bootstrap_tenants.sh`

## Prereqs

- `bash`, `curl`, `jq`, `openssl`
- Chalk API reachable

## Run

```bash
bash .codex/skills/chalk-tenant-bootstrap/scripts/bootstrap_tenants.sh
```

Optional base URL:

```bash
CHALK_API_BASE_URL=https://chalk-api.q9labs.ai bash .codex/skills/chalk-tenant-bootstrap/scripts/bootstrap_tenants.sh
```

## Output

- JSONL artifact in `/tmp/chalk_tenants_recreate_*.jsonl`
- Markdown table to stdout:
  - tenant name
  - tenant id
  - api key
  - webhook secret
  - allowed origin
  - webhook url

## Defaults applied to each tenant

- `max_concurrent_rooms=150`
- `max_participants_per_room=20`
- `max_recording_duration_minutes=180`
- `force_recording=true`
- `auto_start_recording=true`
- `allow_early_join=true`
- `transcription_enabled=true`
- `transcription_language=en-US`
- post-meeting webhook enabled
- include flags enabled (`recording`, `transcript`, `summary`, `action_items`)
- transcription provider: `whisper`
- ai provider: `openrouter`
