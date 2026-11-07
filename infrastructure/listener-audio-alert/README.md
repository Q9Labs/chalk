# Listener audio check

`listener-audio-check.mjs` runs every five minutes from the
[listener audio workflow](../../.github/workflows/listener-audio-check.yml).
It queries the last ten minutes of production API logs in Axiom and posts to
Oncall when an Episode has at least one `media.listener_publication_unpulled`
event (`api_unpulled`). This detects missing provider pull acceptance, not
proof of received audio. The API samples and emits after its grace window;
the target is a page within roughly five minutes of that signal, not a hard
delivery SLA: GitHub scheduled jobs can be delayed.

One incident merges all signal counts for an Episode and includes the UTC query
window. The stable key is `listener-audio:chalk:<episode_id>`; Oncall dedupes
overlapping ten-minute windows and later repeats by key. A fired alert also
fails the run so GitHub emails the failure. Query and webhook failures fail the
run too. Empty results succeed without posting. Because
`media.listener_publication_unpulled` is one-shot per pair, a stuck Episode
stops firing roughly ten minutes after its last new event, even if the
underlying problem remains.

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
values; `synthetic_second` exercises merging without enabling a second signal.

Run the workflow by hand with `drill` set to send one marked test to Oncall.
A drill needs only the webhook, never reads Axiom, and exits successfully.
It uses the synthetic Episode key `listener-audio:chalk:00000000-0000-4000-8000-000000000001`.
Oncall acts only on checks in its registry ([Q9Labs/oncall apps.ts](https://github.com/Q9Labs/oncall/blob/master/apps.ts)), so the
`listener-audio` scope must be registered there for Chalk. That is a follow-up
outside this repository; posting alone does not make the alarm operational.

The signal table is deliberately small. #721 will add `sdk.connection_report`
with `['attributes.trigger'] == 'audio_receive_stuck'` as a second signal;
it is not queried today. Its event and trigger predicate must be included in
that table entry when it lands.

```sh
node --test infrastructure/listener-audio-alert/listener-audio-check.test.mjs
```

To undo, delete the workflow and this folder, remove the Alarm subsection in
the observability docs, and remove the two dedicated Axiom secrets. Keep the
shared `ONCALL_WEBHOOK_URL` used by other checks. Remove the Oncall registration
separately if it has been added.
