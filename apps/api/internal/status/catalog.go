package status

// ComponentCatalog is deliberately independent of monitor targets. These
// names and descriptions are safe to publish and remain stable when probes or
// deployment URLs change.
func ComponentCatalog() []ComponentDefinition {
	return []ComponentDefinition{
		{ID: "web", Name: "Web", Description: "Chalk web application", MonitorKeys: []string{"web.space", "web.account_boundary"}},
		{ID: "api", Name: "API", Description: "Chalk control plane API", MonitorKeys: []string{"api.health", "api.readiness"}},
		{ID: "sync", Name: "Sync", Description: "Realtime collaboration service", MonitorKeys: []string{"sync.health", "sync.readiness"}},
		{ID: "broker", Name: "Episode access", Description: "Episode access service", MonitorKeys: []string{"broker.health"}},
	}
}

func knownMonitorKeys() map[string]struct{} {
	keys := make(map[string]struct{})
	for _, component := range ComponentCatalog() {
		for _, key := range component.MonitorKeys {
			keys[key] = struct{}{}
		}
	}
	// The architecture boundary is optional in the uptime worker. Keep it
	// valid for ingestion without making it a required public component.
	keys["architecture.access_boundary"] = struct{}{}
	return keys
}
