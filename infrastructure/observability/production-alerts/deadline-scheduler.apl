['${LOG_DATASET}']
| where ['service.name'] == 'chalk-api' and ['attributes.event'] == 'episode.deadline_scheduler.failed' and _time > ago(5m)
| extend reason=tostring(['attributes.reason']), consecutive=tolong(column_ifexists('attributes.consecutive_failures', 0)), tenant_id=tostring(['attributes.tenant_id']), episode_id=tostring(['attributes.episode_id']), phase=tostring(column_ifexists('attributes.phase', ''))
| where consecutive > iff(reason == 'control_busy', 60, 5)
| summarize value=max(consecutive) by tenant_id, episode_id, reason, phase
| extend alert_message=strcat('\n', tenant_id, '\ndeadline-scheduler\nEpisodes may not end on time\nThe deadline scheduler keeps failing for ', iff(isempty(episode_id), 'a whole pass', strcat('Episode ', episode_id)), ' (reason: ', reason, ', phase: ', iff(isempty(phase), 'none', phase), '). Other Episodes are still handled; this one will not end by its deadline or after it empties until the cause is fixed.\nAn engineer must investigate; ending the Episode by hand clears it.\nFor engineers: search the API log dataset for episode.deadline_scheduler.failed and this Episode ID. control_busy alerts after 60 consecutive passes (a foreign publication fence outlives its operation); any other reason alerts after 5.\n')
| project alert_message, value
