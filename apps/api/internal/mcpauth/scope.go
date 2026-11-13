package mcpauth

import (
	"slices"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

// Connected apps get one of two bundles built from an explicit allowlist, so a
// new scope is never granted until someone adds it here. Neither bundle includes
// API keys, signing keys, memberships, deletes or tenant settings, so a connected
// app cannot read credentials, list members or widen its own access.
var contentResources = []string{"spaces", "episodes", "recordings", "transcriptions", "webhooks"}

// SupportedScopes lists the bundles a client may request, smallest first.
func SupportedScopes() []string { return []string{ScopeRead, ScopeManage} }

// SmallestBundleGranting names the smallest bundle that includes scope, or ""
// when no bundle does (API keys, memberships, tenant settings and deletes), so
// asking the person to approve a bigger bundle would never help.
func SmallestBundleGranting(scope authentication.Scope) string {
	for _, bundle := range SupportedScopes() {
		if slices.Contains(AuthenticationScopes(bundle), scope) {
			return bundle
		}
	}
	return ""
}

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
// Both bundles read the tenant and its content; only manage writes.
func AuthenticationScopes(scope string) []authentication.Scope {
	var scopes []authentication.Scope
	for _, candidate := range authentication.AllScopes {
		resource, action, _ := strings.Cut(string(candidate), ":")
		switch {
		case candidate == authentication.ScopeTenantsRead:
			scopes = append(scopes, candidate)
		case !slices.Contains(contentResources, resource):
		case action == "read", action == "write" && scope == ScopeManage:
			scopes = append(scopes, candidate)
		}
	}
	return scopes
}
