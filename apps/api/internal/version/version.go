package version

// Build-time variables injected via -ldflags
// Example: go build -ldflags "-X github.com/Q9Labs/chalk/internal/version.CommitSHA=$(git rev-parse HEAD)"
var (
	CommitSHA = "unknown"
	Version   = "dev"
	BuildTime = "unknown"
)
