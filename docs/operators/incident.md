# Incident response

When production breaks, restore service first and fix properly afterwards. Addresses, IDs, credentials and customer names stay in private operator notes, never here. Times marked "measured" come from rehearsals on nightly; "not measured" means nobody has timed it yet.

## Decide in two minutes

Roll back when the last deploy is the likely cause and the previous release can run on today's data. Fix forward when the cause is outside the release, or a migration already ran (migrations only move forward, and the previous release must still read the new schema: that is why database removals keep the previous release runnable).

1. Did a deploy, config change or flag change happen in the last hour? If not, look first (below) before you touch anything.
2. Can one switch below stop the damage without a deploy? A kill switch or a Space setting takes seconds. Use it before a rollback.
3. Is the fix one small commit that is already on master with a green push Gate? Use the hotfix path.
4. Otherwise restore the previous release with the restore action for the part that broke.

The Oncall agent may roll production back to the previous release without asking when the evidence shows a production release caused the incident and the restore command below exists. It then checks that service is restored and tells the owner what it rolled back, why, and how to roll forward. The proper fix still goes through a pull request.

## Where to look first

[Observability](../observability.md) has the full guide. In order:

1. The uptime monitor's message says which check failed. The join probe fails at a named stage: create Episode, admit participant, or Sync handshake.
2. A user's problem report prints `Last failed request: <journey id> (HTTP <status>)`. Search the API log for that journey ID to get the route, status and error code.
3. For one Episode, search both the API log and the Sync trace for its ID.
4. Check what shipped last: the newest runs of `Release`, `Cut nightly`, `Promote` and `Hotfix`.

## Restore one deployable

| Part                | Restore action                                                                                                                                                                                                                                                                                                          | Time                                          | Does not restore                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| API and Sync        | Run `python3 scripts/releases/hotfix.py rollback-command` with `GH_TOKEN` set. It reads the retained production releases and prints one `gh workflow run ci.yml` line that restores the release before the running one. Run that line once. Promote and Hotfix run the same job for you when the real-call smoke fails. | 617 s measured on nightly, 12 Nov 2026        | Migrations. Data written by the new release stays.               |
| Web                 | Get the previous Pages deployment ID with `python3 scripts/releases/web.py previous` (needs `PAGES_PROJECT`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the operator notes), then add `--pages-id <id>` to the command above. The one `Release` run restores web and backend together.                     | 11 s for the Pages step, measured 12 Nov 2026 | Vendor assets are immutable and stay.                            |
| SFU nodes           | Run the node deploy script from a checkout of the previous release commit. Roll the web and the node back together when the new web raises the offer size limit ([upgrade order](../../infrastructure/sfu/README.md)).                                                                                                  | not measured                                  | Episodes already bound to a node keep it.                        |
| Recorder fleet pins | The same `Release` rollback restores the previous recorder archive pins and dispatcher ZIP.                                                                                                                                                                                                                             | included above                                | Workers running the new pins drain through the normal lifecycle. |
| Cloudflare workers  | `wrangler rollback <version id>` for that Worker. Write down the version ID before every deploy.                                                                                                                                                                                                                        | 9 s measured on nightly, 12 Nov 2026          | Secrets and KV values changed since.                             |
| npm `latest`        | `python3 scripts/releases/npm_dist_tags.py restore` with the retained tags, or `npm dist-tag add <package>@<previous> latest`.                                                                                                                                                                                          | not measured                                  | Published versions stay. npm never unpublishes them for you.     |
| Mobile              | Halt the staged rollout in the store console and submit the previous build. There is no over-the-air update.                                                                                                                                                                                                            | store review time                             | Installed builds. A fix needs a new build.                       |

A rollback that cannot find its baseline fails closed and prints the manual inputs. Use those inputs; do not rebuild.

Before a binary rollback to a release older than `73c89bd5e` (the commit that made `chalk_sfu` an allowed platform default), restore `CHALK_DEFAULT_MEDIA_PLANE=cf_sfu` in the production API environment and move any Space that stored `chalk_sfu` back with `media-settings set --plane cf_sfu`. The older binary cannot start with a `chalk_sfu` default.

## Hotfix path

Run the `Hotfix` workflow from master with the commit SHA of a fix that is already on master. It refuses a SHA that is not on master, has no green push Gate, or does not contain the release now running. Then it:

1. builds on the release now running and validates the release,
2. deploys API, Sync and web, with that release kept as the rollback baseline,
3. runs the real-call smoke on the own SFU,
4. rolls back by itself if the smoke fails, and stays red until someone confirms service.

It skips the nightly record, latency and long-call proofs, the scorecard and npm publish. Measured on nightly on 12 Nov 2026: 22.3 minutes from dispatch to live with the build reused (backend deploy 660 s, web 124 s, real-call smoke 457 s), and about 30 minutes with a fresh 8.3 minute build and validate. A forced smoke failure restored service 10.5 minutes after the rollback started. After the incident, the next nightly cut carries the fix through the normal path, and the postmortem below closes the gap that let it through.

## Kill switches and media plane settings

| Switch                                                                      | Effect                                             | How fast                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| `media-settings new-episodes --state off --operator <name> --reason <text>` | Every new Episode uses Cloudflare. Audit row kept. | Next new Episode, no deploy and no restart.         |
| `media-settings set --plane cf_sfu` for one Space                           | Next Episodes of that Space use Cloudflare.        | Seconds, no deploy. Live Episodes keep their plane. |
| `media-settings set --tenant <id>` for a Tenant default                     | Next Episodes of that Tenant follow it.            | Seconds, no deploy.                                 |

The first row is an emergency stop for new Episodes, not the normal failover: a live call never moves to Cloudflare, and a new Episode that no own-SFU node can take is refused with a retryable `503 media.unavailable`. `--state on` turns it back on. `CHALK_SFU_NEW_EPISODES=off` in the API environment is a deploy-time floor under it: while it says off, the switch is off whatever the database says.

Commands, rules and the rollback caveats are in the [SFU README](../../infrastructure/sfu/README.md#which-plane-a-new-episode-gets) and the [rollout notes](../sfu/production-rollout.md#undo). To end a live call on the wrong plane, end its Episode through the API.

## Never stop the production node

Stopping the production node ends every live call and every recording on it. Deploys, hotfixes and rollbacks run through SSM and the deployment controller on the running node, so no release step ever stops or reboots the instance. EC2 stop protection (`DisableApiStop`) therefore blocks only a manual stop, and a real deploy runs as before. It does not block a reboot, an OS shutdown or a termination.

The protection is a setting on the instance, not a file in Git. The instance ID is in the private operator notes. Run these with the operator AWS profile:

```sh
aws ec2 describe-instance-attribute --instance-id <production instance id> --attribute disableApiStop
aws ec2 modify-instance-attribute --instance-id <production instance id> --disable-api-stop
```

A stop call now fails with `OperationNotPermitted`. To stop the node on purpose, do it outside an incident and tell the owner first. Undo the protection with `aws ec2 modify-instance-attribute --instance-id <production instance id> --no-disable-api-stop`, stop the node, then turn the protection on again after it starts. An agent that holds the same credentials can still remove the protection, but only with that explicit second call.

## Postmortem

Write five lines within two working days, and ship the last line.

1. What users saw, and from when to when.
2. What changed, and how we found out.
3. Why the checks did not stop it.
4. What restored service, and how long each step took.
5. The check, test or alert that now fails when this happens again: link the change.
