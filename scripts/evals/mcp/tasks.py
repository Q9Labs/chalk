"""Task inputs and independent fact/state oracles. No LLM graders."""

from dataclasses import dataclass
import json

from fixture import quote


@dataclass(frozen=True)
class Task:
    id: str
    prompt: str
    expected: object
    sql: str | None = None
    state: str | None = None
    capability_gap: bool = False


def suite(f):
    tenant = quote(f["tenant"])
    atlas = quote(f["spaces"]["Atlas"])
    retired = quote(f["spaces"]["Retired"])
    key = quote(f["rotate_key"])
    return [
        Task("connection", 'Identify the connected tenant. Return {"name":string}.', {"name": "MCP Evaluation"}),
        Task("active-spaces", 'List every nonarchived Space. Return {"names":[names sorted alphabetically]}.',
             {"names": ["Atlas", "Beacon", "Commons"]}),
        Task("archived-spaces", 'List every archived Space. Return {"names":[names sorted alphabetically]}.',
             {"names": ["Retired"]}),
        Task("space-settings", 'Inspect Atlas. Return {"recording_policy":string,"transcription_policy":string}.',
             {"recording_policy": "manual", "transcription_policy": "on_demand"}),
        Task("episode-counts", 'Count all Episodes, both active and ended, separately for Atlas and Beacon. Return {"Atlas":integer,"Beacon":integer}.',
             {"Atlas": 4, "Beacon": 3}),
        Task("attendance", 'For the Atlas Episode starting 2026-10-19 at 10:00 UTC, list all participants who attended. Return {"names":[names sorted alphabetically]}.',
             {"names": ["Amina", "Bilal", "Chen"]}),
        Task("frequent-attendees", 'Across ALL Spaces, which people attended MORE THAN 3 ended Episodes during 2026-10-19T00:00:00Z inclusive to 2026-10-26T00:00:00Z exclusive? Count distinct Episodes per person, not sessions. Return {"attendees":[{"name":string,"episodes":integer}]} sorted by name.',
             {"attendees": [{"name": "Amina", "episodes": 5}, {"name": "Bilal", "episodes": 4}]}),
        Task("live-spaces", 'Find all Spaces with an active Episode. Return {"names":[Space names sorted alphabetically]}.',
             {"names": ["Atlas", "Commons"]}),
        Task("admissions", 'Who is waiting for admission to Atlas? Return {"names":[display names sorted alphabetically]}.',
             {"names": ["Esha"]}),
        Task("exports", 'Inspect every recording and count export statuses ready and failed. Return {"ready":integer,"failed":integer}.',
             {"ready": 3, "failed": 1}),
        Task("transcript-languages", 'Across all transcript artifacts, count those containing each language en, ur, ar (mixed artifacts count in each language). Return {"en":integer,"ur":integer,"ar":integer}.',
             {"en": 2, "ur": 2, "ar": 2}),
        Task("memberships", 'List tenant membership roles by person name. Return {"Amina":string,"Bilal":string,"Chen":string}.',
             {"Amina": "owner", "Bilal": "collaborator", "Chen": "observer"}),
        Task("webhook-history", 'For webhook Fixture archive, count historical succeeded and exhausted deliveries. Return {"succeeded":integer,"exhausted":integer}.',
             {"succeeded": 1, "exhausted": 1}),
        Task("archive-space", 'Archive Beacon, then read it back to verify. Return {"name":"Beacon","archived":boolean}.',
             {"name": "Beacon", "archived": True},
             f"select archived_at is not null from spaces where tenant_id={tenant} and name='Beacon'", "t"),
        Task("recording-settings", 'Change Atlas recording policy to disabled without changing its transcription policy. Read settings back. Return {"recording_policy":string,"transcription_policy":string}.',
             {"recording_policy": "disabled", "transcription_policy": "on_demand"},
             f"select recording_policy || ':' || transcription_policy from spaces where id={atlas}", "disabled:on_demand"),
        Task("rotate-key", 'Rotate the API key named Automation key, NOT the Evaluation runner key. Verify its ID, name and scopes are preserved and the key remains active with newly issued credentials. Never print secrets. Return {"rotated":boolean,"same_key_id":boolean,"scopes":[strings]}.',
             {"rotated": True, "same_key_id": True, "scopes": ["spaces:read"]},
             f"select count(*)=1 and bool_and(id={key} and revoked_at is null and key_hash<>{quote(f['rotate_key_hash'])} and key_prefix<>{quote(f['rotate_key_prefix'])} and scopes=ARRAY['spaces:read']) from api_keys where tenant_id={tenant} and name='Automation key'", "t"),
        Task("create-test-webhook", 'Create an ENABLED webhook named Eval events with URL https://example.invalid/eval and event type episode.ended. Send one test event, then inspect deliveries to verify the test was queued (actual network delivery is not required). Return {"created":boolean,"test_queued":boolean}. Never print signing secrets.',
             {"created": True, "test_queued": True},
             f"select count(*)=1 from webhook_endpoints e join webhook_endpoint_revisions r on r.endpoint_id=e.id and r.revision=e.current_target_revision join webhook_deliveries d on e.id=d.endpoint_id join webhook_events v on v.id=d.event_id where e.tenant_id={tenant} and e.name='Eval events' and e.enabled and r.url_redacted='https://example.invalid/eval' and r.event_types=ARRAY['episode.ended'] and v.event_name='endpoint.test'", "t"),
        Task("change-membership", 'Change Chen from observer to collaborator. Read memberships back to verify. Return {"name":"Chen","role":string}.',
             {"name": "Chen", "role": "collaborator"},
             f"select m.role from memberships m join users u on m.user_id=u.id where m.tenant_id={tenant} and u.name='Chen'", "collaborator"),
        Task("missing-scope", 'Attempt to rename the tenant to Forbidden rename. Do NOT pretend it succeeded if the key lacks permission. Report the exact required scope. Return {"changed":boolean,"missing_scope":string}.',
             {"changed": False, "missing_scope": "tenants:write"},
             f"select name from tenants where id={tenant}", "MCP Evaluation"),
        Task("restore-space", 'Restore archived Space Retired. Read it back to verify. Return {"name":"Retired","archived":boolean}.',
             {"name": "Retired", "archived": False},
             f"select archived_at is null from spaces where id={retired}", "t"),
        Task("invoice-search", 'Search ALL transcript text for English invoicing (not invoice). Return every matching utterance as {"matches":[{"speaker":string,"start_ms":integer,"text":string}]}.',
             {"matches": [{"speaker": "Amina", "start_ms": 12000, "text": "Please review invoicing on Tuesday."}]}, capability_gap=True),
        Task("urdu-reading", 'Read the Urdu-only transcript. Return its first utterance exactly, preserving Urdu script, as {"speaker":string,"start_ms":integer,"text":string}.',
             {"speaker": "Amina", "start_ms": 12000, "text": "انوائسنگ کی رپورٹ منگل کو بھیجیں۔"}, capability_gap=True),
        Task("arabic-reading", 'Read the Arabic-only transcript. Return its first utterance exactly, preserving Arabic script, as {"speaker":string,"start_ms":integer,"text":string}.',
             {"speaker": "Amina", "start_ms": 12000, "text": "يرجى إرسال الفاتورة يوم الثلاثاء."}, capability_gap=True),
        Task("long-transcript", 'Read the entire long mixed-language transcript and find the invoice approval code. Return {"code":string,"speaker":string,"start_ms":integer}.',
             {"code": "ORCHID-73", "speaker": "Amina", "start_ms": 4100000}, capability_gap=True),
    ]


def grade(task, answer, db, evidence=None):
    facts = json.dumps(answer, sort_keys=True) == json.dumps(task.expected, sort_keys=True)
    state = task.sql is None or db.query(task.sql) == task.state
    checks = {"facts": facts, "state": state}
    if task.id == "missing-scope":
        outcomes = (evidence or {}).get("server_outcomes", {})
        checks["scope_rejection_observed"] = outcomes.get("chalk_update_tenant:auth.forbidden", 0) > 0
    return all(checks.values()), checks
