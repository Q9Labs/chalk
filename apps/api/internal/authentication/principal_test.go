package authentication_test

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

func TestPrincipalHasScope(t *testing.T) {
	principal := authentication.Principal{
		Kind: authentication.PrincipalAPIKey,
		Scopes: []authentication.Scope{
			authentication.ScopeTenantsRead,
			authentication.ScopeRoomsWrite,
		},
	}

	if !principal.HasScope(authentication.ScopeRoomsWrite) {
		t.Fatal("principal missing rooms write scope")
	}
	if principal.HasScope(authentication.ScopeRoomsDelete) {
		t.Fatal("principal unexpectedly has rooms delete scope")
	}
}

func TestPrincipalContext(t *testing.T) {
	principal := authentication.Principal{Kind: authentication.PrincipalUser}
	ctx := authentication.ContextWithPrincipal(context.Background(), principal)

	got, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		t.Fatal("principal missing from context")
	}
	if got.Kind != authentication.PrincipalUser {
		t.Fatalf("principal kind = %q, want user", got.Kind)
	}
}

func TestPrincipalFromContextRejectsUnauthenticatedValue(t *testing.T) {
	ctx := authentication.ContextWithPrincipal(context.Background(), authentication.Principal{})

	_, ok := authentication.PrincipalFromContext(ctx)
	if ok {
		t.Fatal("empty principal was authenticated")
	}
}

func TestValidScope(t *testing.T) {
	if !authentication.ValidScope(authentication.ScopeAPIKeysWrite) {
		t.Fatal("api keys write scope should be valid")
	}
	if authentication.ValidScope("admin:*") {
		t.Fatal("wildcard scope should not be valid")
	}
}
