['chalk-api-prod']
| where ['attributes.event'] == 'http.request'
| where ['attributes.route'] in ('/v1/tenants/{tenant_id}/spaces/{space_id}/episodes', '/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants')
| summarize n=count(), tenants=dcount(['attributes.tenant_id']) by bin(_time, 1d), ['attributes.route'], ['attributes.status']
| order by _time asc
