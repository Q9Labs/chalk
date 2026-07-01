package authentication

import "context"

type principalContextKey struct{}

// ContextWithPrincipal is for HTTP middleware and tests. Services should still
// receive Principal explicitly so authorization dependencies stay visible.
func ContextWithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalContextKey{}, principal)
}

func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalContextKey{}).(Principal)
	if !ok || !principal.IsAuthenticated() {
		return Principal{}, false
	}

	return principal, true
}
