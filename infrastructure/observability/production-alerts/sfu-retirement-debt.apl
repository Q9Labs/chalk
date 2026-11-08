['${LOG_DATASET}']
| where chalk_alert_stream == 'production-state-v2' and chalk_alert_rule == 'sfu-retirement-debt' and _time > ago(5m)
| extend probe_minute=bin(_time, 1m)
| summarize arg_max(_time, chalk_alert_value, chalk_alert_headline, chalk_alert_summary, chalk_alert_next, chalk_alert_engineers) by probe_minute
| summarize stale_minutes=countif(chalk_alert_value > ${SFU_RETIREMENT_DEBT_MAX_AGE_SECONDS}), arg_max(_time, chalk_alert_value, chalk_alert_headline, chalk_alert_summary, chalk_alert_next, chalk_alert_engineers)
| where _time > ago(90s)
| extend value=iff(stale_minutes >= 4 and chalk_alert_value > ${SFU_RETIREMENT_DEBT_MAX_AGE_SECONDS}, 1, 0)
| extend alert_message=strcat('\n\n', 'sfu-retirement-debt', '\n', chalk_alert_headline, '\n', chalk_alert_summary, '\n', chalk_alert_next, '\n', chalk_alert_engineers, '\n')
| project alert_message, value
