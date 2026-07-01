package authentication

import "github.com/q9labs/chalk/apps/api/internal/utilities"

type PrincipalKind string

const (
	PrincipalUser   PrincipalKind = "user"
	PrincipalAPIKey PrincipalKind = "api_key"
	PrincipalSystem PrincipalKind = "system"
)

// Principal is the authenticated caller accepted at the HTTP edge. It can
// represent a user session, a tenant-bound API key, or rare internal system work.
type Principal struct {
	Kind      PrincipalKind
	UserID    utilities.ID
	TenantID  utilities.ID
	SessionID utilities.ID
	APIKeyID  utilities.ID
	Scopes    []Scope
}

func (p Principal) HasScope(scope Scope) bool {
	for _, candidate := range p.Scopes {
		if candidate == scope {
			return true
		}
	}

	return false
}

func (p Principal) IsAuthenticated() bool {
	return p.Kind == PrincipalUser || p.Kind == PrincipalAPIKey || p.Kind == PrincipalSystem
}
