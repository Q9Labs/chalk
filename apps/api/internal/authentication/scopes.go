package authentication

import "slices"

type Scope string

const (
	ScopeTenantsRead   Scope = "tenants:read"
	ScopeTenantsWrite  Scope = "tenants:write"
	ScopeTenantsDelete Scope = "tenants:delete"

	ScopeMembershipsRead   Scope = "memberships:read"
	ScopeMembershipsWrite  Scope = "memberships:write"
	ScopeMembershipsDelete Scope = "memberships:delete"

	ScopeSpacesRead   Scope = "spaces:read"
	ScopeSpacesWrite  Scope = "spaces:write"
	ScopeSpacesDelete Scope = "spaces:delete"

	ScopeEpisodesRead   Scope = "episodes:read"
	ScopeEpisodesWrite  Scope = "episodes:write"
	ScopeEpisodesDelete Scope = "episodes:delete"

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

	ScopeWebhooksRead   Scope = "webhooks:read"
	ScopeWebhooksWrite  Scope = "webhooks:write"
	ScopeWebhooksDelete Scope = "webhooks:delete"
)

var AllScopes = []Scope{
	ScopeTenantsRead,
	ScopeTenantsWrite,
	ScopeTenantsDelete,
	ScopeMembershipsRead,
	ScopeMembershipsWrite,
	ScopeMembershipsDelete,
	ScopeSpacesRead,
	ScopeSpacesWrite,
	ScopeSpacesDelete,
	ScopeEpisodesRead,
	ScopeEpisodesWrite,
	ScopeEpisodesDelete,
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
	ScopeWebhooksRead,
	ScopeWebhooksWrite,
	ScopeWebhooksDelete,
}

func ValidScope(scope Scope) bool {
	return slices.Contains(AllScopes, scope)
}

// Derived scopes are never issued to a credential and are absent from AllScopes.
// A tool that needs a rule stronger than any single issued scope checks one of
// them, and DerivedScopes decides who holds it.
const (
	// ScopeTenantSettingsRead guards the settings view of the MCP inspect_tenant
	// tool. API keys that hold tenants:read have it; OAuth bundles do not, even
	// though they hold tenants:read for the profile.
	ScopeTenantSettingsRead Scope = "tenants:settings:read"
	// ScopeCallCredentialsIssue guards the MCP control_call tool, whose actions
	// return live credentials that let the holder join a call as a Participant.
	// API keys that hold episodes:write have it; OAuth bundles do not, even
	// though chalk:manage holds episodes:write.
	ScopeCallCredentialsIssue Scope = "episodes:credentials:issue"
)

// DerivedScopes lists the derived scopes principal holds.
func DerivedScopes(principal Principal) []Scope {
	var derived []Scope
	if principal.Kind != PrincipalAPIKey {
		return derived
	}
	if principal.HasScope(ScopeTenantsRead) {
		derived = append(derived, ScopeTenantSettingsRead)
	}
	if principal.HasScope(ScopeEpisodesWrite) {
		derived = append(derived, ScopeCallCredentialsIssue)
	}
	return derived
}
