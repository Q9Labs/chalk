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

	err := authorizer.AuthorizeTenant(ctx, principal, tenantID, permission)
	authorized := tenantID
	if err != nil {
		authorized = utilities.ID{}
	}
	if limitErr := checkTenantRateLimit(ctx, authorized); limitErr != nil {
		return limitErr
	}
	return err
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
