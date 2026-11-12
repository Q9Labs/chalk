['${LOG_DATASET}']
| where ['service.name'] == 'chalk-api' and ['attributes.event'] == 'sdk.connection_report'
| extend tenant_id=tostring(['attributes.tenant_id']), episode_id=tostring(['attributes.episode_id']), provider=iff(tostring(['attributes.provider']) in ('cloudflare_sfu', 'chalk_sfu'), tostring(['attributes.provider']), 'unknown'), participant=tostring(['attributes.participant_id_hash']), trigger=tostring(['attributes.trigger']), report=parse_json(tostring(['attributes.report']))
| where trigger in ('join_failed', 'recovery_exhausted', 'media_projection_mismatch', 'audio_receive_stuck', 'upload_failed')
| extend report_provider=provider, provider=iff(trigger == 'upload_failed', 'any', provider)
| extend diagnostic=toarray(report.events)
| mv-expand diagnostic
| where trigger !in ('media_projection_mismatch', 'audio_receive_stuck') or (trigger == 'audio_receive_stuck' and diagnostic.event == 'audio_receive_stuck' and diagnostic.source in ('microphone', 'screen_audio')) or (diagnostic.event == 'media_projection_mismatch' and diagnostic.source in ('microphone', 'camera') and ((diagnostic.publication_state == 'on' and diagnostic.projection_state == 'off') or (diagnostic.publication_state == 'off' and diagnostic.projection_state == 'on')))
| where trigger != 'upload_failed' or diagnostic.event == 'chat_upload_failed'
| extend source=case(trigger in ('media_projection_mismatch', 'audio_receive_stuck'), tostring(diagnostic.source), trigger == 'upload_failed', tostring(diagnostic.upload_failure), ''), publication_state=tostring(diagnostic.publication_state), projection_state=tostring(diagnostic.projection_state), receive_state=tostring(diagnostic.receive_state), duration_ms=tostring(diagnostic.duration_ms), attempt=tostring(diagnostic.attempt)
| extend media_error_kind=tostring(diagnostic.media_error_kind), media_error_step=tostring(diagnostic.media_error_step), cause_order=iff(trigger in ('media_projection_mismatch', 'audio_receive_stuck') or isnotempty(diagnostic.media_error_kind) or isnotempty(diagnostic.media_error_step), tolong(diagnostic.elapsed_ms), -1)
| summarize media_start=countif(diagnostic.code == 'media_start_failed'), media_recovery=countif(diagnostic.code == 'media_recovery_exhausted'), arg_max(cause_order, report_provider, media_error_kind, media_error_step, publication_state, projection_state, receive_state, duration_ms, attempt) by _time, tenant_id, episode_id, provider, participant, trigger, source
| extend failure=case(trigger == 'join_failed' and media_start > 0, 'media_start_failed', trigger == 'join_failed', 'join_failed', trigger == 'recovery_exhausted' and media_recovery > 0, 'media_recovery_exhausted', trigger == 'media_projection_mismatch', 'media_projection_mismatch', trigger == 'audio_receive_stuck', 'audio_receive_stuck', trigger == 'upload_failed', 'chat_upload_failed', '')
| where isnotempty(failure)
| extend episode_id=iff(failure == 'chat_upload_failed', 'several episodes', episode_id)
| summarize first_seen=min(_time), last_seen=max(_time), arg_max(_time, report_provider, media_error_kind, media_error_step, publication_state, projection_state, receive_state, duration_ms, attempt) by tenant_id, episode_id, provider, failure, source, participant
| summarize value=count(), first_seen=min(first_seen), arg_max(last_seen, report_provider, media_error_kind, media_error_step, publication_state, projection_state, receive_state, duration_ms, attempt) by tenant_id, episode_id, provider, failure, source
| where failure != 'chat_upload_failed' or value >= 3
| extend provider=iff(failure == 'chat_upload_failed', report_provider, provider)
| join kind=leftouter (
    ['${LOG_DATASET}']
    | where chalk_alert_stream == 'production-state-v2' and isnotempty(chalk_alert_tenant)
    | extend tenant_name=coalesce(ensure_field('chalk_alert_tenant_name', typeof(string)), chalk_alert_tenant)
    | summarize arg_max(_time, tenant_name) by chalk_alert_tenant
    | project tenant_id=chalk_alert_tenant, tenant_name
  ) on tenant_id
| extend tenant=iff(isempty(tenant_name) or tenant_name == tenant_id, tenant_id, strcat(tenant_name, ' (', tenant_id, ')')), first_pkt=replace_string('Z', '', tostring(datetime_add('hour', 5, todatetime(first_seen))))
| extend media_error_kind=iff(isempty(media_error_kind), 'unknown', media_error_kind), media_error_step=iff(isempty(media_error_step), 'unknown', media_error_step)
| extend detail=case(failure == 'chat_upload_failed', strcat('Cause: ', source, ' (storage_unreachable on a browser that otherwise works means the bucket CORS rule no longer allows the Tenant origin).'), failure == 'audio_receive_stuck', strcat('Source: ', source, '; furthest receive state: ', iff(isempty(receive_state), 'unknown', receive_state), '; media_error_kind: ', media_error_kind, '.'), failure == 'media_projection_mismatch', strcat('Source: ', source, '; publication: ', publication_state, '; projection: ', projection_state, '. Duration: ', iff(isempty(duration_ms), 'unknown', strcat(duration_ms, ' ms')), '; attempt: ', iff(isempty(attempt), 'unknown', attempt), '.'), strcat('Latest media_error_kind: ', media_error_kind, '; media_error_step: ', media_error_step, '.'))
| project value, alert_message=strcat('\n', tenant_id, '\nconnection-report\n', iff(failure == 'chat_upload_failed', 'Chat uploads are failing', 'A class connection failed'), '\nTenant: ', tenant, '. Episode: ', episode_id, '. Failure: ', failure, '. Provider: ', provider, '. First reported: ', first_pkt, ' PKT. ', detail, iff(failure == 'chat_upload_failed', '\nCheck the bucket CORS rule against the Tenant origins and run pnpm prod:proof chat-upload.', '\nIn class: mute then unmute for missing audio; rejoin once if still broken. Use Report a problem when available. If rejoining does not restore the call, use the agreed fallback.'), '\nFor engineers: connection-report; open the API log dataset and search this Episode ID: ', episode_id, '. Count is distinct affected participants in ten minutes.\n')
