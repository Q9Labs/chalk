package authentication

import "github.com/q9labs/chalk/apps/api/internal/utilities"

type PrincipalKind string

const (
	PrincipalKindUser   PrincipalKind = "user"
	PrincipalKindAPIKey PrincipalKind = "api_key"
	PrincipalKindSystem PrincipalKind = "system"
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
	return p.Kind == PrincipalKindUser || p.Kind == PrincipalKindAPIKey || p.Kind == PrincipalKindSystem
}
