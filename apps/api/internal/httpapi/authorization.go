package httpapi

import (
	"context"
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

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

func authorizeSystem(ctx context.Context) error {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind != authentication.PrincipalSystem {
		return apiErrorForbidden
	}

	return nil
}

func authorizeAccountRead(ctx context.Context, userID utilities.ID) error {
	principal, ok := authentication.PrincipalFromContext(ctx)
	if !ok {
		return apiErrorUnauthenticated
	}
	if principal.Kind == authentication.PrincipalSystem {
		return nil
	}
	if principal.Kind != authentication.PrincipalUser || principal.UserID != userID {
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
