---
name: chalk-mobile-wireless-debug
description: Use when connecting a local Android device over wireless ADB, launching a locally installed Chalk mobile build, or updating generic mobile debugging scripts without exposing private device or app identifiers.
---

# Chalk Mobile Wireless Debug

Use this skill when connecting a local Android device over wireless ADB or launching a locally installed Chalk mobile build.

## Guardrails

- Keep device IPs, package names, and local operator preferences out of committed docs.
- Use `ADB_SERIAL`, `ADB_DEVICE_IP`, `ADB_TCP_PORT`, and `CHALK_MOBILE_PACKAGE` for machine-specific values.
- Do not commit debug APKs, screenshots, logs, or generated Android build output.

## Commands

```bash
pnpm run mobile:connect
CHALK_MOBILE_PACKAGE="example.package" pnpm run mobile:launch
pnpm run mobile:install:local -- --no-launch
```

The scripts in this skill are intentionally generic so the public repo does not encode private mobile app identifiers.
