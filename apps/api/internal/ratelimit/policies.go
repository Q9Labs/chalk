package ratelimit

const (
	PolicyNameAuthRegister       = "auth.register"
	PolicyNameAuthLogin          = "auth.login"
	PolicyNameAuthMe             = "auth.me"
	PolicyNameAuthOAuthStart     = "auth.oauth.start"
	PolicyNameAuthOAuthCallback  = "auth.oauth.callback"
	PolicyNameAuthenticatedWrite = "v1.authenticated.write"
	PolicyNameWebhookRead        = "v1.webhooks.read"
	PolicyNameTelemetryIntake    = "v1.telemetry.intake"
)

const (
	HeaderLimit      = "X-RateLimit-Limit"
	HeaderRemaining  = "X-RateLimit-Remaining"
	HeaderRetryAfter = "Retry-After"
)
