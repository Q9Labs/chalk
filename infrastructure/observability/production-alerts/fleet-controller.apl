['${LOG_DATASET}']
| where ['service.name'] in ('chalk-recorder-fleet-controller', 'chalk-sfu-window-controller') and _time > ago(10m)
| where (['body'] == 'recorder fleet reconciliation failed' and severity_text == 'ERROR') or (['body'] == 'SFU window reconcile incomplete' and severity_text == 'WARN')
| summarize value=count() by service=tostring(['service.name'])
| where value >= 20
| extend alert_message=strcat('\n\nfleet-controller\nA capacity controller keeps failing\nThe ', service, ' failed ', tostring(value), ' passes in ten minutes, so new Recording capture workers or scheduled-class Chalk SFU nodes may not be created.\nAn engineer must read the controller error in the API log dataset (service.name ', service, '); a rejected cloud-provider token is the usual cause.\nFor engineers: fleet-controller; the error text is on the failing log line.\n')
| project alert_message, value
