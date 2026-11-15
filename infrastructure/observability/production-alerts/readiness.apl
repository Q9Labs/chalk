['${LOG_DATASET}']
| where chalk_alert_stream == 'production-state-v2' and chalk_alert_rule in ('sync-readiness', 'database-unreachable', 'runtime-health') and _time > ago(4m)
| extend probe_minute=bin(_time, 1m)
| summarize arg_max(_time, chalk_alert_value, chalk_alert_headline, chalk_alert_summary, chalk_alert_next, chalk_alert_engineers) by chalk_alert_rule, probe_minute
| summarize unready_minutes=countif(chalk_alert_value > 0), arg_max(_time, chalk_alert_value, chalk_alert_headline, chalk_alert_summary, chalk_alert_next, chalk_alert_engineers) by chalk_alert_rule
| where _time > ago(90s)
| extend value=iff(unready_minutes >= 3 and chalk_alert_value > 0, 1, 0)
| extend alert_message=strcat('\n\n', chalk_alert_rule, '\n', chalk_alert_headline, '\n', chalk_alert_summary, '\n', chalk_alert_next, '\n', chalk_alert_engineers, '\n', 'Still failing at ', format_datetime(bin(now(), 30m), 'HH:mm'), ' UTC; this message repeats every 30 minutes until it recovers.', '\n')
| project alert_message, value
