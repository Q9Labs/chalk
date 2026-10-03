`dispatcher-rebind-plan.json` is reduced from the retained E30 dispatcher binding
plan (2026-10-03). It keeps changed fields, provider unknown-field structure and
one unchanged authentication reference. All string values are replaced; resource
addresses and field names describe the public module. The full plan deferred
three unchanged IAM/SQS policies. Rebinding therefore targets the log group and
then Lambda, with a full no-drift check afterward; the plan guard still rejects
those unknown policy changes. No production identifiers or policy bodies remain.
