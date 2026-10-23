package authentication

// ServiceCredential identifies one deployment-owned caller across secret rotations.
// An empty ID leaves service authentication disabled.
type ServiceCredential struct {
	ID      string
	Secrets []string `secret:"true"`
	Scopes  []Scope
}
