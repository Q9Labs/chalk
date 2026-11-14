['${LOG_DATASET}']
| where ['service.name'] == 'chalk-api' and ['attributes.event'] in ('cloudflare_turn.credentials_failed', 'chalk_sfu.turn_credentials_failed') and _time > ago(5m)
| summarize value=count()
| where value >= ${TURN_MINT_FAILURES_IN_5M}
| extend alert_message=strcat('\n\nturn-credentials\nPeople on strict networks cannot connect media\nThe API could not mint TURN credentials for several joins in five minutes, so those joins used STUN only. Clients on UDP-blocked networks cannot connect media.\nAn engineer must check the TURN provider and the Chalk SFU relay now.\nFor engineers: search the API log dataset for cloudflare_turn.credentials_failed and chalk_sfu.turn_credentials_failed and read the error field.\n')
| project alert_message, value
