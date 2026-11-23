['${LOG_DATASET}']
| where ['service.name'] == 'chalk-api' and ['body'] == 'chalk sfu node is out of placement' and _time > ago(5m)
| where tostring(column_ifexists('attributes.reason', '')) == 'node_protocol_too_old'
| summarize value=count()
| extend alert_message=strcat('\n\nsfu-node-too-old\nA Chalk SFU node is too old for this API\nThe API found a Chalk SFU node below the wire protocol it sends and stopped placing new Episodes on it. A node that old refuses what the new API or SDK sends, such as a listen-only join, with 400 invalid_request.\nAn engineer must deploy the node from the release commit.\nFor engineers: sfu-node-too-old; read the node and protocol on the API log line, then follow the Node too old steps in the Chalk SFU runbook.\n')
| project alert_message, value
