# Listener audio check

`listener-audio-check.mjs` runs every five minutes from the [listener audio workflow](../../.github/workflows/listener-audio-check.yml). It queries the last ten minutes of production API logs in Axiom and posts to Oncall when an Episode meets the rule of a signal. The signals are a small table at the top of the script (event name, optional trigger, optional `minParticipants`), so a new one is one entry.

- `api_unpulled` (`media.listener_publication_unpulled`): one event pages. Only Cloudflare SFU emits it, so it is blind to `chalk_sfu`; delete the entry when M13 removes Cloudflare.
- `client_audio_stuck:<provider>` (`sdk.connection_report` with trigger `audio_receive_stuck`): works for both providers. It pages only when at least two distinct participants reported it, because one client can repeat or mis-report (production once showed 52 reports across 26 Episodes in one afternoon). Reports with no participant hash never count as a participant.

These detect missing provider pull acceptance or stalled receive, not proof of audible audio. The target is a page within roughly five minutes, not a hard SLA: GitHub scheduled jobs can be delayed. Both signals are one-shot (the SDK reports at most eight per media session), so a stuck Episode stops firing roughly ten minutes after its last new event even if the problem remains.

One incident merges all signal counts for an Episode under the key `listener-audio:chalk:<episode_id>`; Oncall dedupes overlapping windows by key. A fired alert, a query failure or a webhook failure fails the run so GitHub emails it. Malformed, partial, estimated, non-JSON and HTTP error responses fail rather than imply health. Empty results succeed without posting.

Privacy: the APL projects only `episode_id`, `signal`, `events` and `participants`, so participant hashes never leave Axiom. Public workflow output has only aggregate counts. Valid UUID Episode IDs go only to Oncall.

Secrets: `CHALK_AXIOM_QUERY_TOKEN` (query permission on the API log dataset), `CHALK_AXIOM_LOG_DATASET` (kept secret so public logs mask it; it must be the dataset the production Axiom monitors use, because the query does not filter by environment and a dataset holding nightly logs would page for nightly) and the shared `ONCALL_WEBHOOK_URL`.

Run the workflow by hand with `drill` set to send one marked test to Oncall; it needs only the webhook. Oncall acts only on checks in its registry ([Q9Labs/oncall apps.ts](https://github.com/Q9Labs/oncall/blob/master/apps.ts)), so the `listener-audio` scope must be registered there for Chalk. Posting alone does not make the alarm operational.

```sh
node --test infrastructure/listener-audio-alert/listener-audio-check.test.mjs
```

To undo, delete the workflow and this folder, remove the Alarm subsection in the observability docs, and remove the two dedicated Axiom secrets. Keep the shared `ONCALL_WEBHOOK_URL`. Remove the Oncall registration separately.
