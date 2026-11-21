['${LOG_DATASET}']
| where ['service.name'] == 'chalk-api' and ['attributes.event'] == 'sdk.telemetry'
| extend evidence=parse_json(iff(body startswith 'chalk-evidence-v2:', substring(body, 18), '{}'))
| extend type=coalesce(tostring(evidence.type), tostring(column_ifexists('attributes.type', ''))),
    code=coalesce(tostring(evidence.code), tostring(column_ifexists('attributes.code', ''))),
    state=coalesce(tostring(evidence.state), tostring(column_ifexists('attributes.state', ''))),
    tenant_id=tostring(['attributes.tenant_id']),
    episode_id=tostring(['attributes.episode_id']),
    provider_hint=coalesce(tostring(evidence.provider), tostring(column_ifexists('attributes.provider', ''))),
    participant=coalesce(tostring(evidence.participant_id_hash), tostring(column_ifexists('attributes.participant_id_hash', ''))),
    source=coalesce(tostring(evidence.source), tostring(column_ifexists('attributes.source', ''))),
    upload_failure=coalesce(tostring(evidence.upload_failure), tostring(column_ifexists('attributes.upload_failure', ''))),
    publication_state=coalesce(tostring(evidence.publication_state), tostring(column_ifexists('attributes.publication_state', ''))),
    projection_state=coalesce(tostring(evidence.projection_state), tostring(column_ifexists('attributes.projection_state', ''))),
    receive_state=coalesce(tostring(evidence.receive_state), tostring(column_ifexists('attributes.receive_state', ''))),
    duration_ms=coalesce(tostring(evidence.duration_ms), tostring(column_ifexists('attributes.duration_ms', ''))),
    attempt=coalesce(tostring(evidence.attempt), tostring(column_ifexists('attributes.attempt', ''))),
    media_error_kind=coalesce(tostring(evidence.media_error_kind), tostring(column_ifexists('attributes.media_error_kind', ''))),
    media_error_step=coalesce(tostring(evidence.media_error_step), tostring(column_ifexists('attributes.media_error_step', '')))
| extend provider=iff(provider_hint in ('cloudflare_sfu', 'chalk_sfu'), provider_hint, 'unknown')
| extend failure=case(type == 'chat_upload_failed', 'chat_upload_failed', type == 'audio_receive_stuck' and source in ('microphone', 'screen_audio'), 'audio_receive_stuck', type == 'media_projection_mismatch' and source in ('microphone', 'camera') and ((publication_state == 'on' and projection_state == 'off') or (publication_state == 'off' and projection_state == 'on')), 'media_projection_mismatch', type in ('space_join_span', 'connection_failed') and code == 'media_start_failed', 'media_start_failed', type == 'connection_failed' and state == 'joining', 'join_failed', type == 'recovery_exhausted' and code == 'media_recovery_exhausted', 'media_recovery_exhausted', '')
| where isnotempty(failure)
| where isempty(coalesce(tostring(evidence.legacy_route), tostring(column_ifexists('attributes.legacy_route', '')))) or coalesce(tostring(evidence.trigger), tostring(column_ifexists('attributes.trigger', ''))) == case(failure == 'chat_upload_failed', 'upload_failed', failure in ('media_start_failed', 'join_failed'), 'join_failed', failure == 'media_recovery_exhausted', 'recovery_exhausted', failure)
| extend report_provider=provider, provider=iff(failure == 'chat_upload_failed', 'any', provider), source=case(failure in ('media_projection_mismatch', 'audio_receive_stuck'), source, failure == 'chat_upload_failed', upload_failure, ''), cause_order=iff(failure in ('media_projection_mismatch', 'audio_receive_stuck') or isnotempty(media_error_kind) or isnotempty(media_error_step), tolong(['attributes.elapsed_ms']), -1)
| summarize arg_max(cause_order, report_provider, media_error_kind, media_error_step, publication_state, projection_state, receive_state, duration_ms, attempt) by _time, tenant_id, episode_id, provider, failure, source, participant
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
