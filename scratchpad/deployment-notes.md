# Deployment Notes

## Release Configuration

Release builds must not accidentally use local development hosts or stale host
keys. Production wrappers should force production API and websocket origins,
then verify required host configuration before packaging.

## Mobile Releases

Android release verification should check:

- package and version code are correct
- release bundle/APK comes from the intended environment
- internal testing points at the newly uploaded build
- screen share, PiP, foreground service, and permission flows still behave on a
  real or representative device

iOS release verification should check:

- archive/export uses the intended release environment
- screen share extension entitlements and app group behavior work
- simulator-only capabilities are not mistaken for device behavior
- App Store metadata and privacy answers are reviewed by a human before public
  submission

Simulator restarts and local device state can cause false negatives. Keep only
the recovery pattern: reset simulator/device state, rebuild with the intended
environment, and verify the user-level flow again.

## Operations

- migrations are release blockers when code references new schema
- deploys should include post-deploy verification against the actual live
  revision
- raw CI logs are not durable documentation; summarize the failure mode and
  final fix
- operational dashboards and status pages should expose user-facing health, not
  private internal topology
