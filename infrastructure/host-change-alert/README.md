# Host change check

`host-change-check.mjs` runs every five minutes from the [host change workflow](../../.github/workflows/host-change-check.yml). It posts to Oncall in two cases:

- `host-change`: CloudTrail shows `StopInstances`, `StartInstances` or `RebootInstances` on the production node in the last 30 minutes. CloudTrail can lag by several minutes, so a page can arrive after the call. Oncall dedupes on the CloudTrail event ID.
- `api-start`: Axiom shows `api.starting` in the last ten minutes with no production release record open at that time. A record explains starts from its creation until its deploy completes; a record that never completed (a failed attempt) explains starts for 30 minutes after its creation. The page prints `previous_boot_end` (`clean`, `killed` or `unknown`), which the restore service records at boot.

A fired alert, a query failure or a webhook failure fails the run so GitHub emails it. Run the workflow by hand with `drill` set to send one marked test to Oncall; it needs only the webhook. Oncall acts only on checks in its registry ([Q9Labs/oncall apps.ts](https://github.com/Q9Labs/oncall/blob/master/apps.ts)), so register the `host-change:chalk:` and `api-start:chalk:` keys there.

Inputs: the secrets `CHALK_AXIOM_QUERY_TOKEN`, `CHALK_AXIOM_LOG_DATASET`, `ONCALL_WEBHOOK_URL` (shared with the listener audio check) and `CHALK_PRODUCTION_INSTANCE_ID` (private, never in Git). The workflow assumes the AWS role named by the repository variable `CHALK_HOST_CHANGE_ROLE_ARN` (`chalk-host-change-reader`), which can only call `cloudtrail:LookupEvents` and trusts only this repository's master branch.

```sh
node --test infrastructure/host-change-alert/host-change-check.test.mjs
```

To undo, delete the workflow and this folder, delete the role (`aws iam delete-role-policy --role-name chalk-host-change-reader --policy-name cloudtrail-lookup`, then `aws iam delete-role --role-name chalk-host-change-reader`), and delete the secret `CHALK_PRODUCTION_INSTANCE_ID` and the variable `CHALK_HOST_CHANGE_ROLE_ARN`.
