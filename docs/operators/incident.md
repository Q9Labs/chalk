# Incident response

When production breaks, restore service first and fix properly afterwards. Addresses, IDs, credentials and customer names stay in private operator notes, never here. Times marked "measured" come from rehearsals on nightly; "not measured" means nobody has timed it yet.

## Decide in two minutes

Roll back when the last deploy is the likely cause and the previous release can run on today's data. Fix forward when the cause is outside the release, or a migration already ran (migrations only move forward, and the previous release must still read the new schema: that is why database removals keep the previous release runnable).

1. Did a deploy, config change or flag change happen in the last hour? If not, look first (below) before you touch anything.
2. Can one switch below stop the damage without a deploy? A kill switch or a Space setting takes seconds. Use it before a rollback.
3. Is the fix one small commit that is already on master with a green push Gate? Use the hotfix path.
4. Otherwise restore the previous release with the restore action for the part that broke.

The Oncall agent may roll production back to the previous release without asking when the evidence shows a release caused the incident and a documented rollback exists. It checks that service is back, then tells the owner what it rolled back, why, and how to roll forward.

## Where to look first

[Observability](../observability.md) has the full guide. In order:

1. The uptime monitor's message says which check failed. The join probe fails at a named stage: create Episode, admit participant, or Sync handshake.
2. A user's problem report prints `Last failed request: <journey id> (HTTP <status>)`. Search the API log for that journey ID to get the route, status and error code.
3. For one Episode, search both the API log and the Sync trace for its ID.
4. Check what shipped last: the newest runs of `Release`, `Cut nightly`, `Promote` and `Hotfix`.

## Restore one deployable

| Part                | Restore action                                                                                                                                                                                                         | Time              | Does not restore                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| API and Sync        | `Release` from master with the previous manifest and `reuse_release_id`. Promote and Hotfix call it for you when the real-call smoke fails.                                                                            | TIMES_BACKEND     | Migrations. Data written by the new release stays.               |
| Web                 | Pages rollback of the saved deployment ID. Part of the same `Release` run.                                                                                                                                             | TIMES_WEB         | Vendor assets are immutable and stay.                            |
| SFU nodes           | Run the node deploy script from a checkout of the previous release commit. Roll the web and the node back together when the new web raises the offer size limit ([upgrade order](../../infrastructure/sfu/README.md)). | not measured      | Episodes already bound to a node keep it.                        |
| Recorder fleet pins | The same `Release` rollback restores the previous recorder archive pins and dispatcher ZIP.                                                                                                                            | included above    | Workers running the new pins drain through the normal lifecycle. |
| Cloudflare workers  | `wrangler rollback <version id>` for that Worker. Write down the version ID before every deploy.                                                                                                                       | TIMES_WORKER      | Secrets and KV values changed since.                             |
| npm `latest`        | `python3 scripts/releases/npm_dist_tags.py restore` with the retained tags, or `npm dist-tag add <package>@<previous> latest`.                                                                                         | not measured      | Published versions stay. npm never unpublishes them for you.     |
| Mobile              | Halt the staged rollout in the store console and submit the previous build. There is no over-the-air update.                                                                                                           | store review time | Installed builds. A fix needs a new build.                       |

A rollback that cannot find its baseline fails closed and prints the manual inputs. Use those inputs; do not rebuild.

Before any binary rollback to a release older than the one that made `chalk_sfu` the platform default, set `CHALK_DEFAULT_MEDIA_PLANE=cf_sfu` in the production environment, and move any Space that stored `chalk_sfu` with `media-settings`. The rollback restart then reads it. The older binary cannot start with a `chalk_sfu` default.

## Hotfix path

Run the `Hotfix` workflow from master with the commit SHA of a fix that is already on master. It refuses a SHA that is not on master, has no green push Gate, or does not contain the release now running. Then it:

1. builds on the release now running and validates the release,
2. deploys API, Sync and web, with that release kept as the rollback baseline,
3. runs the real-call smoke on the own SFU,
4. rolls back by itself if the smoke fails, and stays red until someone confirms service.

It skips the nightly record, latency and long-call proofs, the scorecard and npm publish. Measured on nightly: TIMES_HOTFIX. After the incident, the next nightly cut carries the fix through the normal path, and the postmortem below closes the gap that let it through.

## Kill switches and media plane settings

| Switch                                                  | Effect                                      | How fast                                                           |
| ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `media-settings set --plane cf_sfu` for one Space       | Next Episodes of that Space use Cloudflare. | Seconds, no deploy. Live Episodes keep their plane.                |
| `media-settings set --tenant <id>` for a Tenant default | Next Episodes of that Tenant follow it.     | Seconds, no deploy.                                                |
| `media-settings new-episodes --state off`               | Every new Episode uses Cloudflare.          | Seconds, no deploy and no restart. Live Episodes keep their plane. |

Commands, rules and the rollback caveats are in the [SFU README](../../infrastructure/sfu/README.md#which-plane-a-new-episode-gets) and the [rollout notes](../sfu/production-rollout.md#undo). To end a live call on the wrong plane, end its Episode through the API.

## Postmortem

Write five lines within two working days, and ship the last line.

1. What users saw, and from when to when.
2. What changed, and how we found out.
3. Why the checks did not stop it.
4. What restored service, and how long each step took.
5. The check, test or alert that now fails when this happens again: link the change.
