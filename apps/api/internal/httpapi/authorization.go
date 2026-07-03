package httpapi

import (
	"errors"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func authorizeTenantRequest(w http.ResponseWriter, r *http.Request, authorizer TenantAuthorizer, tenantID utilities.ID, permission authorization.TenantPermission) bool {
	if authorizer == nil {
		writeServiceUnavailable(w)
		return true
	}

	principal, ok := authentication.PrincipalFromContext(r.Context())
	if !ok {
		writeUnauthenticated(w)
		return true
	}

	err := authorizer.AuthorizeTenant(r.Context(), principal, tenantID, permission)
	switch {
	case err == nil:
		return false
	case errors.Is(err, authorization.ErrUnauthenticated):
		writeUnauthenticated(w)
	case errors.Is(err, authorization.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "Access denied")
	case errors.Is(err, authorization.ErrInvalidTenantID):
		writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}

	return true
}

func authorizeGlobalReadRequest(w http.ResponseWriter, r *http.Request) bool {
	principal, ok := authentication.PrincipalFromContext(r.Context())
	if !ok {
		writeUnauthenticated(w)
		return true
	}
	if principal.Kind != authentication.PrincipalSystem {
		writeError(w, http.StatusForbidden, "forbidden", "Access denied")
		return true
	}

	return false
}
