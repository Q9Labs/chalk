package authentication

type Scope string

const (
	ScopeTenantsRead   Scope = "tenants:read"
	ScopeTenantsWrite  Scope = "tenants:write"
	ScopeTenantsDelete Scope = "tenants:delete"

	ScopeMembershipsRead   Scope = "memberships:read"
	ScopeMembershipsWrite  Scope = "memberships:write"
	ScopeMembershipsDelete Scope = "memberships:delete"

	ScopeUsersRead   Scope = "users:read"
	ScopeUsersWrite  Scope = "users:write"
	ScopeUsersDelete Scope = "users:delete"

	ScopeRoomsRead   Scope = "rooms:read"
	ScopeRoomsWrite  Scope = "rooms:write"
	ScopeRoomsDelete Scope = "rooms:delete"

	ScopeSessionsRead   Scope = "sessions:read"
	ScopeSessionsWrite  Scope = "sessions:write"
	ScopeSessionsDelete Scope = "sessions:delete"

	ScopeRecordingsRead   Scope = "recordings:read"
	ScopeRecordingsWrite  Scope = "recordings:write"
	ScopeRecordingsDelete Scope = "recordings:delete"

	ScopeTranscriptionsRead   Scope = "transcriptions:read"
	ScopeTranscriptionsWrite  Scope = "transcriptions:write"
	ScopeTranscriptionsDelete Scope = "transcriptions:delete"

	ScopeSigningKeysRead   Scope = "signing_keys:read"
	ScopeSigningKeysWrite  Scope = "signing_keys:write"
	ScopeSigningKeysDelete Scope = "signing_keys:delete"

	ScopeAPIKeysRead   Scope = "api_keys:read"
	ScopeAPIKeysWrite  Scope = "api_keys:write"
	ScopeAPIKeysDelete Scope = "api_keys:delete"
)

// AllScopes is explicit by design: API keys must be granted concrete scopes,
// not wildcard permissions that become surprising as resources are added.
var AllScopes = []Scope{
	ScopeTenantsRead,
	ScopeTenantsWrite,
	ScopeTenantsDelete,
	ScopeMembershipsRead,
	ScopeMembershipsWrite,
	ScopeMembershipsDelete,
	ScopeUsersRead,
	ScopeUsersWrite,
	ScopeUsersDelete,
	ScopeRoomsRead,
	ScopeRoomsWrite,
	ScopeRoomsDelete,
	ScopeSessionsRead,
	ScopeSessionsWrite,
	ScopeSessionsDelete,
	ScopeRecordingsRead,
	ScopeRecordingsWrite,
	ScopeRecordingsDelete,
	ScopeTranscriptionsRead,
	ScopeTranscriptionsWrite,
	ScopeTranscriptionsDelete,
	ScopeSigningKeysRead,
	ScopeSigningKeysWrite,
	ScopeSigningKeysDelete,
	ScopeAPIKeysRead,
	ScopeAPIKeysWrite,
	ScopeAPIKeysDelete,
}

func ValidScope(scope Scope) bool {
	for _, candidate := range AllScopes {
		if candidate == scope {
			return true
		}
	}

	return false
}
