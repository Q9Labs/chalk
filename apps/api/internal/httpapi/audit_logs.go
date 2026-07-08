package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/auditlogs"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var readAuditLogsPermission = authorization.TenantPermission{
	Scope:       authentication.ScopeAuditLogsRead,
	MinimumRole: memberships.RoleAdmin,
}

type AuditLogService interface {
	Get(ctx context.Context, tenantID utilities.ID, auditLogID utilities.ID) (auditlogs.AuditLog, error)
	List(ctx context.Context, tenantID utilities.ID, page pagination.PageRequest) (auditlogs.AuditLogList, error)
}

type auditLogResponse struct {
	ID           string  `json:"id"`
	TenantID     string  `json:"tenant_id"`
	ActorUserID  *string `json:"actor_user_id"`
	ActorType    string  `json:"actor_type"`
	Action       string  `json:"action"`
	Details      any     `json:"details"`
	Outcome      string  `json:"outcome"`
	ErrorCode    *string `json:"error_code"`
	ErrorMessage *string `json:"error_message"`
	Before       any     `json:"before"`
	After        any     `json:"after"`
	UpdatedAt    string  `json:"updated_at"`
	CreatedAt    string  `json:"created_at"`
}

type auditLogListResponse struct {
	AuditLogs  []auditLogResponse `json:"audit_logs"`
	Pagination paginationResponse `json:"pagination"`
}

type listAuditLogsRequest struct {
	TenantID utilities.ID
	Page     pagination.PageRequest
}

type getAuditLogRequest struct {
	TenantID   utilities.ID
	AuditLogID utilities.ID
}

func mountAuditLogRoutes(r chi.Router, service AuditLogService, authorizer TenantAuthorizer, limits RateLimitOptions) {
	for _, endpoint := range auditLogEndpoints(service, authorizer) {
		endpoint.Mount(r, limits)
	}
}

func auditLogEndpoints(service AuditLogService, authorizer TenantAuthorizer) []RouteEndpoint {
	return []RouteEndpoint{
		listAuditLogsEndpoint(service, authorizer),
		getAuditLogEndpoint(service, authorizer),
	}
}

func listAuditLogsEndpoint(service AuditLogService, authorizer TenantAuthorizer) Endpoint[listAuditLogsRequest, auditLogListResponse] {
	return Get("/v1/tenants/{tenant_id}/audit-logs", "/tenants/{tenant_id}/audit-logs", "listAuditLogs", decodeListAuditLogsRequest, func(ctx context.Context, request listAuditLogsRequest) (auditLogListResponse, error) {
		if service == nil {
			return auditLogListResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readAuditLogsPermission); err != nil {
			return auditLogListResponse{}, err
		}

		list, err := service.List(ctx, request.TenantID, request.Page)
		if err != nil {
			return auditLogListResponse{}, err
		}
		return newAuditLogListResponse(list)
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(append([]APIParameterContract{tenantIDParameter()}, paginationParameters()...)...).
		Responds(http.StatusOK, "AuditLogList", auditLogListResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidTenantID,
			apiErrorInvalidPageSize,
			apiErrorInvalidCursor,
			apiErrorInternal,
		).
		MapErrors(auditLogEndpointAPIError)
}

func getAuditLogEndpoint(service AuditLogService, authorizer TenantAuthorizer) Endpoint[getAuditLogRequest, auditLogResponse] {
	return Get("/v1/tenants/{tenant_id}/audit-logs/{audit_log_id}", "/tenants/{tenant_id}/audit-logs/{audit_log_id}", "getAuditLog", decodeGetAuditLogRequest, func(ctx context.Context, request getAuditLogRequest) (auditLogResponse, error) {
		if service == nil {
			return auditLogResponse{}, apiErrorServiceUnavailable
		}
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readAuditLogsPermission); err != nil {
			return auditLogResponse{}, err
		}

		log, err := service.Get(ctx, request.TenantID, request.AuditLogID)
		if err != nil {
			return auditLogResponse{}, err
		}
		return newAuditLogResponse(log), nil
	}).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter(), auditLogIDParameter()).
		Responds(http.StatusOK, "AuditLog", auditLogResponse{}).
		Errors(
			apiErrorUnauthenticated,
			apiErrorForbidden,
			apiErrorServiceUnavailable,
			apiErrorInvalidTenantID,
			apiErrorInvalidAuditLogID,
			apiErrorAuditLogNotFound,
			apiErrorInternal,
		).
		MapErrors(auditLogEndpointAPIError)
}

func decodeListAuditLogsRequest(r *http.Request) (listAuditLogsRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listAuditLogsRequest{}, err
	}
	page, err := parsePageRequest(r)
	if err != nil {
		return listAuditLogsRequest{}, paginationAPIError(err)
	}
	return listAuditLogsRequest{TenantID: tenantID, Page: page}, nil
}

func decodeGetAuditLogRequest(r *http.Request) (getAuditLogRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return getAuditLogRequest{}, err
	}
	auditLogID, err := auditLogIDRequest(r)
	if err != nil {
		return getAuditLogRequest{}, err
	}
	return getAuditLogRequest{TenantID: tenantID, AuditLogID: auditLogID}, nil
}

func auditLogEndpointAPIError(err error) (APIError, bool) {
	if apiErr, ok := auditLogServiceAPIError(err); ok {
		return apiErr, true
	}
	return authorizationAPIError(err), true
}

func auditLogServiceAPIError(err error) (APIError, bool) {
	switch {
	case err == nil:
		return APIError{}, false
	case errors.Is(err, auditlogs.ErrInvalidTenantID):
		return apiErrorInvalidTenantID, true
	case errors.Is(err, auditlogs.ErrInvalidAuditLogID):
		return apiErrorInvalidAuditLogID, true
	case errors.Is(err, auditlogs.ErrAuditLogNotFound):
		return apiErrorAuditLogNotFound, true
	default:
		return APIError{}, false
	}
}

func newAuditLogListResponse(list auditlogs.AuditLogList) (auditLogListResponse, error) {
	page, err := newPaginationResponse(list.Page)
	if err != nil {
		return auditLogListResponse{}, err
	}

	response := auditLogListResponse{AuditLogs: make([]auditLogResponse, 0, len(list.AuditLogs)), Pagination: page}
	for _, log := range list.AuditLogs {
		response.AuditLogs = append(response.AuditLogs, newAuditLogResponse(log))
	}
	return response, nil
}

func newAuditLogResponse(log auditlogs.AuditLog) auditLogResponse {
	return auditLogResponse{
		ID:           log.ID.String(),
		TenantID:     log.TenantID.String(),
		ActorUserID:  optionalIDString(log.ActorUserID),
		ActorType:    log.ActorType,
		Action:       log.Action,
		Details:      rawJSONValue(log.Details),
		Outcome:      log.Outcome,
		ErrorCode:    log.ErrorCode,
		ErrorMessage: log.ErrorMessage,
		Before:       rawJSONValue(log.Before),
		After:        rawJSONValue(log.After),
		UpdatedAt:    utilities.FormatTimestamp(log.UpdatedAt),
		CreatedAt:    utilities.FormatTimestamp(log.CreatedAt),
	}
}
