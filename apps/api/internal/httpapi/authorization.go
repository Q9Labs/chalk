package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func authorizeTenantRequest(w http.ResponseWriter, r *http.Request, authorizer TenantAuthorizer, tenantID utilities.ID, permission authorization.TenantPermission) bool {
	if err := authorizeTenant(r.Context(), authorizer, tenantID, permission); err == nil {
		return false
	} else {
		writeAPIError(w, authorizationAPIError(err))
		return true
	}
}

func authorizeGlobalReadRequest(w http.ResponseWriter, r *http.Request) bool {
	if err := authorizeGlobalRead(r.Context()); err == nil {
		return false
	} else {
		writeAPIError(w, authorizationAPIError(err))
		return true
	}
}

func authorizeTenant(ctx context.Context, authorizer TenantAuthorizer, tenantID utilities.ID, permission authorization.TenantPermission) error {
	if authorizer == nil {
		return apiErrorServiceUnavailable
	}

	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}

	return authorizer.AuthorizeTenant(ctx, principal, tenantID, permission)
}

func authorizeGlobalRead(ctx context.Context) error {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalSystem {
		return apiErrorForbidden
	}

	return nil
}

func authorizationAPIError(err error) APIError {
	if apiErr, ok := errorAsAPIError(err); ok {
		return apiErr
	}

	switch {
	case errors.Is(err, authorization.ErrUnauthenticated):
		return apiErrorUnauthenticated
	case errors.Is(err, authorization.ErrForbidden):
		return apiErrorForbidden
	case errors.Is(err, authorization.ErrInvalidTenantID):
		return apiErrorInvalidTenantID
	default:
		return apiErrorInternal
	}
}
