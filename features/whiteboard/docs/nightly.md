# Test a branch without changing the nightly release

## The release nightly accepts only master

[Cut nightly](../../../.github/workflows/nightly.yml) runs hourly at minute 17 and
supports manual dispatch. Its first step rejects every ref except
`refs/heads/master`, before checkout. It has no branch or target-SHA input.

The plan in [release.py](../../../scripts/releases/release.py) reads the current
master tip from GitHub. It refuses a stale workflow revision and selects that
master commit. [The GitHub release client](../../../scripts/releases/github_release.py)
accepts Gate evidence only when its head SHA matches and its branch is master.
Scheduled cuts require a push Gate. Manual cuts can also accept master schedule
or dispatch Gate evidence. A green PR run does not qualify.

Dispatching this workflow with a feature-branch ref cannot test the branch. The
underlying [release workflow](../../../.github/workflows/ci.yml) also validates master
Gate evidence. Removing only the first ref guard does not enable branch releases.

## Use branch verification for a short observation period

The cheapest safe check for a layout-only branch is to repeat its full Gate and
Sync topology profile for two or three days. These exercise checked-out branch
code without replacing the shared nightly deployment or weakening release trust.
They are verification runs, not proof that a branch was deployed to nightly.

Both [Gate](../../../.github/workflows/gate.yml) and
[Sync reliability](../../../.github/workflows/sync-reliability.yml) support dispatch
on a branch. Gate dispatch selects every job in full mode. The topology profile
uses a disposable local cluster. From a checkout of the desired branch:

```sh
gh workflow run gate.yml --ref spike/whiteboard-colocation-config
gh workflow run sync-reliability.yml --ref spike/whiteboard-colocation-config -f profile=topology
```

When hosted runners are billing-blocked, do not queue those hosted jobs. Use
Instabox from the pushed branch checkout instead:

```sh
box run -- 'bash scripts/gates/instabox-run.sh --browser'
box run -- 'bash scripts/gates/instabox-run.sh scripts/gates/with-sync-topology.sh apps/sync/scripts/reliability-topology'
```

The bootstrap helper defaults to the full Gate when no command follows
`--browser`. Each invocation fetches the caller's pushed HEAD and deletes its
machine after completion. Pin the checkout to the reviewed SHA for each day and
save each command's output under that SHA. An external scheduled task can repeat
these runs. No schedule was created by this spike.

For results inside Actions during a billing block, use a branch-only verification
workflow with the existing job bodies and `runs-on: [self-hosted, linux, x64,
instabox]`, then service it with `box runner`. That needs a workflow change. The
existing hosted job labels cannot select an Instabox runner by themselves.

A real branch deployment needs a separate preview environment and a branch-aware
release entrypoint with its own immutable artifacts, secrets, concurrency, and
rollback policy. No existing branch-deploy path was established here. Do not point
a modified release workflow at the shared nightly environment merely to test
source layout.
