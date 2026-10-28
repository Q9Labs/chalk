['${LOG_DATASET}']
| where ['service.name'] == 'chalk-api' and ['attributes.event'] == 'sdk.connection_report'
| extend tenant_id=tostring(['attributes.tenant_id']), episode_id=tostring(['attributes.episode_id']), participant=tostring(['attributes.participant_id_hash']), trigger=tostring(['attributes.trigger']), report=parse_json(tostring(['attributes.report']))
| where trigger in ('join_failed', 'recovery_exhausted')
// MEDIA_STATE_MISMATCH_SLOT: add the confirmed report trigger/code here when the SDK/API contract lands. Do not alert on transient media_state events.
| extend diagnostic=toarray(report.events)
| mv-expand diagnostic
| summarize media_start=countif(diagnostic.code == 'media_start_failed'), media_recovery=countif(diagnostic.code == 'media_recovery_exhausted') by _time, tenant_id, episode_id, participant, trigger
| extend failure=case(trigger == 'join_failed' and media_start > 0, 'media_start_failed', trigger == 'join_failed', 'join_failed', trigger == 'recovery_exhausted' and media_recovery > 0, 'media_recovery_exhausted', '')
| where isnotempty(failure)
| summarize first_seen=min(_time) by tenant_id, episode_id, failure, participant
| summarize value=count(), first_seen=min(first_seen) by tenant_id, episode_id, failure
| join kind=leftouter (
    ['${LOG_DATASET}']
    | where chalk_alert_stream == 'production-state-v2' and isnotempty(chalk_alert_tenant)
    | extend tenant_name=coalesce(ensure_field('chalk_alert_tenant_name', typeof(string)), chalk_alert_tenant)
    | summarize arg_max(_time, tenant_name) by chalk_alert_tenant
    | project tenant_id=chalk_alert_tenant, tenant_name
  ) on tenant_id
| extend tenant=iff(isempty(tenant_name) or tenant_name == tenant_id, tenant_id, strcat(tenant_name, ' (', tenant_id, ')')), first_pkt=replace_string('Z', '', tostring(datetime_add('hour', 5, todatetime(first_seen))))
| project value, alert_message=strcat('\n', tenant_id, '\nconnection-report\nA class connection failed\nTenant: ', tenant, '. Episode: ', episode_id, '. Failure: ', failure, '. First reported: ', first_pkt, ' PKT.\nIn class: mute then unmute for missing audio; rejoin once if still broken. Use Report a problem when available. If rejoining does not restore the call, use the agreed fallback.\nFor engineers: connection-report; open the API log dataset and search this Episode ID: ', episode_id, '. Count is distinct affected participants in ten minutes.\n')
