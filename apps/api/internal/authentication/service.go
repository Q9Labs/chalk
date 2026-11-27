package authentication

// ServiceCredential identifies one deployment-owned caller across secret rotations.
type ServiceCredential struct {
	ID      string   `json:"id"`
	Secrets []string `json:"secrets"`
	Scopes  []Scope  `json:"scopes"`
}
