['${LOG_DATASET}']
| where ['service.name'] == 'chalk-api' and ['attributes.event'] == 'chalk_sfu.overflow' and _time > ago(2m)
| where tobool(column_ifexists('attributes.alert_drill', false)) != true
| extend provider=tostring(column_ifexists('attributes.provider', '')), reason=tostring(column_ifexists('attributes.placement_reason', ''))
| summarize value=count() by provider, reason
| extend alert_message=strcat('\n\nsfu-overflow\nA new class left the Chalk SFU\nNew Episodes in the last two minutes ', iff(provider == 'cf_sfu', 'moved to Cloudflare', 'were refused (overflow is off)'), '. Reason: ', reason, '.\nAn engineer must check Chalk SFU capacity and node health: node full, host steal guard closed, draining or not answering. Classes keep working on Cloudflare, but the Chalk SFU is not carrying them.\nFor engineers: search the API log dataset for chalk_sfu.overflow, then read the node /readyz through the SFU deploy tunnel and its media telemetry journal lines.\n')
| project alert_message, value
