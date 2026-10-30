package ratelimit

const (
	PolicyNameCORSPolicyLookup   = "cors.policy_lookup"
	PolicyNameAuthenticatedRead  = "v1.authenticated.read"
	PolicyNameAuthenticatedWrite = "v1.authenticated.write"
	PolicyNameWebhookRead        = "v1.webhooks.read"
	PolicyNameTelemetryIntake    = "v1.telemetry.intake"
)

const (
	HeaderLimit      = "X-RateLimit-Limit"
	HeaderRemaining  = "X-RateLimit-Remaining"
	HeaderRetryAfter = "Retry-After"
)
