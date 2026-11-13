package mcptools

import (
	"context"
	"slices"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

// Connection is the tenant-bound caller of one MCP request. Scopes are what the
// credential was issued; Derived are the scopes the API grants on top of those
// (see authentication.DerivedScopes) and are not shown to the model.
type Connection struct {
	ProfileID string
	TenantID  string
	ActorID   string
	Scopes    []authentication.Scope
	Derived   []authentication.Scope
}

// Holds says whether the connection may make a call that needs scope.
func (c Connection) Holds(scope authentication.Scope) bool {
	return slices.Contains(c.Scopes, scope) || slices.Contains(c.Derived, scope)
}

type Profile struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type connectionKey struct{}

func WithConnection(ctx context.Context, c Connection) context.Context {
	return context.WithValue(ctx, connectionKey{}, c)
}

func ConnectionFrom(ctx context.Context) Connection {
	c, _ := ctx.Value(connectionKey{}).(Connection)
	return c
}

func requireScope(ctx context.Context, scope authentication.Scope) error {
	if !ConnectionFrom(ctx).Holds(scope) {
		return Error{Code: "auth.forbidden", Message: "This connection does not grant the required scope: " + string(scope)}
	}
	return nil
}
