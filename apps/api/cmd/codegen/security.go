package main

// securitySchemes lists the bearer credentials the API accepts, by the name routes cite in their security requirements.
func securitySchemes() map[string]any {
	return map[string]any{
		"sessionOrBearer": map[string]any{
			"type":        "http",
			"scheme":      "bearer",
			"description": "Tenant-scoped API key or local system bearer credential. User sessions are not accepted.",
		},
		"participantMediaBearer": map[string]any{
			"type":         "http",
			"scheme":       "bearer",
			"bearerFormat": "JWT",
			"description":  "Short-lived participant media credential bound to one live participant generation and media-provider connection.",
		},
		"participantTelemetryBearer": map[string]any{
			"type":         "http",
			"scheme":       "bearer",
			"bearerFormat": "JWT",
			"description":  "Participant telemetry token, valid for 24 hours and accepted only by the telemetry route. The participant media credential is accepted there too. It cannot call any other route.",
		},
		"participantSyncBearer": map[string]any{
			"type":         "http",
			"scheme":       "bearer",
			"bearerFormat": "JWT",
			"description":  "Short-lived Sync participant credential bound to one Space Episode and participant generation.",
		},
	}
}
