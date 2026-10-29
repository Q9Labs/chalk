['${LOG_DATASET}']
| where chalk_alert_stream == 'production-state-v2' and chalk_alert_rule == 'sync-readiness' and _time > ago(5m)
| extend probe_minute=bin(_time, 1m)
| summarize arg_max(_time, chalk_alert_value, chalk_alert_headline, chalk_alert_summary, chalk_alert_next, chalk_alert_engineers) by probe_minute
| summarize unready_minutes=countif(chalk_alert_value > 0), arg_max(_time, chalk_alert_value, chalk_alert_headline, chalk_alert_summary, chalk_alert_next, chalk_alert_engineers)
| where _time > ago(90s)
| extend value=iff(unready_minutes >= 4 and chalk_alert_value > 0, 1, 0)
| extend alert_message=strcat('\n\n', 'sync-readiness', '\n', chalk_alert_headline, '\n', chalk_alert_summary, '\n', chalk_alert_next, '\n', chalk_alert_engineers, '\n')
| project alert_message, value
