['${LOG_DATASET}']
| where ['service.name'] in ('chalk-api', 'chalk-sfu') and _time > ago(5m)
| extend service=tostring(['service.name']), version=tostring(['service.version'])
| where isnotempty(version)
| summarize api_versions=make_set_if(version, service == 'chalk-api'), node_versions=make_set_if(version, service == 'chalk-sfu')
| where array_length(api_versions) == 1
| mv-expand node_version=node_versions to typeof(string)
| extend api_commit=extract('^managed-episode-[0-9]{8}T[0-9]{6}Z-([0-9a-f]{8,12})-', 1, tostring(api_versions[0]))
| where isnotempty(api_commit) and not(node_version startswith api_commit)
| summarize value=count()
| extend alert_message=strcat('\n\nsfu-version-skew\nA Chalk SFU node runs a different build than the API\nThe API release names a source commit that no running Chalk SFU node was built from. A node that predates an SFU change refuses what the new API or SDK sends, such as a listen-only join, with 400 invalid_request.\nAn engineer must check whether the node missed an SFU change and deploy it from the release commit if so.\nFor engineers: sfu-version-skew; compare service.version on chalk-sfu logs with the API release, then follow the Version skew steps in the Chalk SFU runbook.\n')
| project alert_message, value
