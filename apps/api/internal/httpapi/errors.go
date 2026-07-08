package httpapi

import "net/http"

type APIError struct {
	Status  int
	Code    string
	Message string
}

func (err APIError) Error() string {
	return err.Code
}

var (
	apiErrorUnauthenticated     = APIError{Status: http.StatusUnauthorized, Code: "unauthenticated", Message: "Authentication required"}
	apiErrorForbidden           = APIError{Status: http.StatusForbidden, Code: "forbidden", Message: "Access denied"}
	apiErrorServiceUnavailable  = APIError{Status: http.StatusServiceUnavailable, Code: "service_unavailable", Message: "Service is not ready"}
	apiErrorInvalidRequest      = APIError{Status: http.StatusBadRequest, Code: "invalid_request", Message: "Invalid request body"}
	apiErrorInvalidPageSize     = APIError{Status: http.StatusBadRequest, Code: "invalid_page_size", Message: "Invalid page size"}
	apiErrorInvalidCursor       = APIError{Status: http.StatusBadRequest, Code: "invalid_cursor", Message: "Invalid cursor"}
	apiErrorInvalidTenantID     = APIError{Status: http.StatusBadRequest, Code: "invalid_tenant_id", Message: "Invalid tenant id"}
	apiErrorInvalidTenantName   = APIError{Status: http.StatusBadRequest, Code: "invalid_tenant_name", Message: "Invalid tenant name"}
	apiErrorInvalidTenantRegion = APIError{Status: http.StatusBadRequest, Code: "invalid_tenant_region", Message: "Invalid tenant region"}
	apiErrorInvalidTenantField  = APIError{Status: http.StatusBadRequest, Code: "invalid_tenant_field", Message: "Invalid tenant field"}
	apiErrorTenantNotFound      = APIError{Status: http.StatusNotFound, Code: "not_found", Message: "Tenant not found"}
	apiErrorRateLimited         = APIError{Status: http.StatusTooManyRequests, Code: "rate_limited", Message: "Too many requests"}
	apiErrorInternal            = APIError{Status: http.StatusInternalServerError, Code: "internal_error", Message: "Internal server error"}
)

func writeAPIError(w http.ResponseWriter, err APIError) {
	writeError(w, err.Status, err.Code, err.Message)
}
