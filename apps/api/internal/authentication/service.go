package authentication

// ServiceCredential identifies one deployment-owned caller across secret rotations.
// An empty ID leaves service authentication disabled.
type ServiceCredential struct {
	ID      string
	Secrets []string
	Scopes  []Scope
	// Dashboard marks the first-party control-plane service. Only it may decide
	// MCP OAuth consent; other trusted services never gain that power from scopes.
	Dashboard bool
}
