# Listener audio check

`listener-audio-check.mjs` runs every five minutes from the
[listener audio workflow](../../.github/workflows/listener-audio-check.yml).
It queries the last ten minutes of production API logs in Axiom and posts to
Oncall when an Episode has at least one of two signals:

- `api_unpulled`: a `media.listener_publication_unpulled` event. Only Cloudflare SFU
  emits it, so it is blind to `chalk_sfu` and goes away when M13 removes Cloudflare.
- `client_audio_stuck:<provider>`: an `sdk.connection_report` with trigger
  `audio_receive_stuck`, sent by a listener's SDK when a desired remote audio
  publication stayed unhealthy for more than ten seconds. It works for both
  providers. The API adds `provider` (`cloudflare_sfu` or `chalk_sfu`) from the
  participant's media credential, and the query puts it in the signal name, with
  anything else shown as `unknown`.

These detect missing provider pull acceptance or stalled receive, not proof of
audible audio. The target is a page within roughly five minutes of the signal, not
a hard delivery SLA: GitHub scheduled jobs can be delayed.

One incident merges all signal counts for an Episode and includes the UTC query
window. The stable key is `listener-audio:chalk:<episode_id>`; Oncall dedupes
overlapping ten-minute windows and later repeats by key. A fired alert also
fails the run so GitHub emails the failure. Query and webhook failures fail the
run too. Empty results succeed without posting. Because
`media.listener_publication_unpulled` is one-shot per pair, and the SDK reports
`audio_receive_stuck` once per unhealthy episode (at most eight per media session),
a stuck Episode stops firing roughly ten minutes after its last new event, even if
the underlying problem remains.

The workflow reads these secrets (no values are provisioned by this change):

- `CHALK_AXIOM_QUERY_TOKEN`: an Axiom API token with query permission on the API log dataset.
- `CHALK_AXIOM_LOG_DATASET`: the private production API log dataset name, kept secret so public logs mask it. This must be the same dataset the production Axiom monitors use as `LOG_DATASET`. The query does not filter by environment: a dataset that also holds nightly logs would page for nightly.
- `ONCALL_WEBHOOK_URL`: the existing Oncall webhook.

The APL projects only `episode_id`, `signal` and `events`. Public workflow output logs
only aggregate Episode and event counts, never IDs, hashes, names, IPs or the
dataset. Valid UUID Episode IDs go only to Oncall; other IDs are dropped.
The parser follows Axiom's documented [tabular response](https://axiom.co/docs/restapi/query):
`tables[0].fields` names map to parallel `columns` arrays. Malformed, partial,
estimated, non-JSON and HTTP error responses fail rather than imply health.
Fixtures in `testdata/` use recorded response shapes with entirely synthetic
values; `synthetic_second` exercises merging of an arbitrary extra signal.

Run the workflow by hand with `drill` set to send one marked test to Oncall.
A drill needs only the webhook, never reads Axiom, and exits successfully.
It uses the synthetic Episode key `listener-audio:chalk:00000000-0000-4000-8000-000000000001`.
Oncall acts only on checks in its registry ([Q9Labs/oncall apps.ts](https://github.com/Q9Labs/oncall/blob/master/apps.ts)), so the
`listener-audio` scope must be registered there for Chalk. That is a follow-up
outside this repository; posting alone does not make the alarm operational.

The signal table is deliberately small. A signal is an event name plus an optional
trigger predicate, so a new one is one table entry. When M13 removes Cloudflare SFU
and its sampler, delete the `api_unpulled` entry.

```sh
node --test infrastructure/listener-audio-alert/listener-audio-check.test.mjs
```

To undo, delete the workflow and this folder, remove the Alarm subsection in
the observability docs, and remove the two dedicated Axiom secrets. Keep the
shared `ONCALL_WEBHOOK_URL` used by other checks. Remove the Oncall registration
separately if it has been added.
