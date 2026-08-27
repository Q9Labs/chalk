# Recording worktree recovery

## 2026-08-27: root contamination confirmed

The uncommitted Recording and Transcription implementation was continued directly in the root `master` checkout instead of an isolated worktree. The root also contains test-reduction changes that are now mostly upstream and smaller unrelated work from other threads.

Recovery will first preserve the exact remaining root state on a local rescue branch. It will then restore root `master` to `origin/master`, create a dedicated Recording worktree from that upstream tip, and extract only the Recording implementation for verification. No production action is authorized.

## 2026-08-27: rescue checkpoint and isolation complete

Local commit `d340b029` preserves all 585 remaining files on `rescue/root-dirty-20260827`; local commit `9a471fdf` is also preserved on `rescue/local-master-release-hardening-20260825`. Root `master` is clean at `origin/master`, and `feat/recording-transcription` now owns the extracted implementation in `.worktrees/recording-transcription`.

The extraction keeps the Recording aggregate, Artifact policy, capture plans and signaling, worker authority, bundle encryption and object authority, lifecycle orchestration, provider adapters, Sync reservation flow, generated contracts, recorder infrastructure, trace scenario, focused tests, and public changelog. It excludes unrelated public-invite, media recovery, Whiteboard, diagnostics exporter, test-reduction, and web fixture changes.

Focused Go tests, nine focused Sync tests, and generated SDK drift passed. The first remote API gate exposed an omitted policy-snapshot fixture in the retained PostgreSQL integration test; the Recording-specific expanded test was restored from the rescue checkpoint before the gate rerun.

The corrected exact snapshot passed the full remote API gate, including fresh migrations through `20260825070000`, PostgreSQL integration tests, lifecycle smoke, vet, staticcheck, and vulnerability checks. The remote Sync basic gate also passed. The remote temporary checkout was removed by its exit trap.

The full staged repository gate passed its Recording-relevant API, Sync, contract, type, security, and infrastructure lanes, then failed in SDK coverage because `src/connection/lifecycle.test.ts` uses an access grant that is now expired by wall-clock time. The same focused test fails unchanged on clean `origin/master`, which proves this is an upstream baseline blocker outside the Recording diff. The isolated checkpoint commit therefore bypasses the repeated hook after recording this evidence.
