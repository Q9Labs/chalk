['${LOG_DATASET}']
| where ['service.name'] == 'chalk-api' and ['attributes.event'] == 'chalk_sfu.recovery_refused' and _time > ago(5m)
| extend refusal_minute=bin(_time, 1m)
| summarize value=dcount(refusal_minute)
| where value >= ${RECOVERY_REFUSED_MINUTES_IN_5M}
| extend alert_message=strcat('\n\nsfu-recovery-refused\nLive calls cannot leave a lost own SFU node\nAn own-SFU node was lost and no node would take its live Episode, in several minutes of the last five. Callers get 503 and retry, and the Episode stays bound to the lost node.\nAn engineer must check own SFU capacity and node health now.\nFor engineers: search the API log dataset for chalk_sfu.recovery_refused and chalk_sfu.recovery, then check pool capacity first.\n')
| project alert_message, value
