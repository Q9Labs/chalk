['chalk-api-prod']
| where ['attributes.event'] == 'sdk.call_stats'
| summarize samples=count(), tenants=dcount(['attributes.tenant_id']), episodes=dcount(['attributes.episode_id']), participants=dcount(['attributes.participant_id_hash']), sessions=dcount(['attributes.session.id']) by bin(_time, 1d)
| order by _time asc
