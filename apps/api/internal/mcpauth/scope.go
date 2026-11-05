package mcpauth

import (
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

// Connected apps get one of two bundles. Neither includes API keys or signing
// keys (not even to read them), membership changes or tenant settings, so a connected app cannot mint
// credentials or widen its own access.
var credentialResources = []string{"api_keys", "signing_keys"}

var manageResources = []string{"spaces", "episodes", "recordings", "transcriptions", "webhooks"}

// NormalizeScope reduces a client's requested scope string to one bundle.
// Unknown scopes are ignored. An empty request gets the read bundle.
func NormalizeScope(requested string) string {
	if slices.Contains(strings.Fields(requested), ScopeManage) {
		return ScopeManage
	}
	return ScopeRead
}

// ApprovalAllowed says whether a person may approve scope for a request: they
// may grant what the client asked for or less, never more.
func ApprovalAllowed(requested, approved string) bool {
	if approved != ScopeRead && approved != ScopeManage {
		return false
	}
	return approved == ScopeRead || NormalizeScope(requested) == ScopeManage
}

// AuthenticationScopes expands a bundle into the scopes the tools check.
func AuthenticationScopes(scope string) []authentication.Scope {
	var scopes []authentication.Scope
	for _, candidate := range authentication.AllScopes {
		resource, action, _ := strings.Cut(string(candidate), ":")
		switch {
		case slices.Contains(credentialResources, resource): // never granted
		case action == "read":
			scopes = append(scopes, candidate)
		case scope == ScopeManage && slices.Contains(manageResources, resource):
			scopes = append(scopes, candidate)
		}
	}
	return scopes
}
