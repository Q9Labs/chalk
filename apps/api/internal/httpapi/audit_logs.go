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

func mountAuditLogRoutes(r chi.Router, service AuditLogService, authorizer TenantAuthorizer) {
	r.Get("/tenants/{tenant_id}/audit-logs", handleListAuditLogs(service, authorizer))
	r.Get("/tenants/{tenant_id}/audit-logs/{audit_log_id}", handleGetAuditLog(service, authorizer))
}

func handleListAuditLogs(service AuditLogService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readAuditLogsPermission) {
			return
		}

		page, err := parsePageRequest(r)
		if writePaginationError(w, err) {
			return
		}

		list, err := service.List(r.Context(), tenantID, page)
		if writeAuditLogServiceError(w, err) {
			return
		}

		response, err := newAuditLogListResponse(list)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
			return
		}
		writeJSON(w, http.StatusOK, response)
	}
}

func handleGetAuditLog(service AuditLogService, authorizer TenantAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if service == nil {
			writeServiceUnavailable(w)
			return
		}

		tenantID, auditLogID, ok := tenantAuditLogIDs(w, r)
		if !ok || authorizeTenantRequest(w, r, authorizer, tenantID, readAuditLogsPermission) {
			return
		}

		log, err := service.Get(r.Context(), tenantID, auditLogID)
		if writeAuditLogServiceError(w, err) {
			return
		}

		writeJSON(w, http.StatusOK, newAuditLogResponse(log))
	}
}

func writeAuditLogServiceError(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, auditlogs.ErrInvalidTenantID):
		writeError(w, http.StatusBadRequest, "invalid_tenant_id", "Invalid tenant id")
	case errors.Is(err, auditlogs.ErrInvalidAuditLogID):
		writeError(w, http.StatusBadRequest, "invalid_audit_log_id", "Invalid audit log id")
	case errors.Is(err, auditlogs.ErrAuditLogNotFound):
		writeError(w, http.StatusNotFound, "not_found", "Audit log not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal_error", "Internal server error")
	}
	return true
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

func tenantAuditLogIDs(w http.ResponseWriter, r *http.Request) (utilities.ID, utilities.ID, bool) {
	tenantID, ok := parseRouteID(w, r, "tenant_id", "invalid_tenant_id", "Invalid tenant id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	auditLogID, ok := parseRouteID(w, r, "audit_log_id", "invalid_audit_log_id", "Invalid audit log id")
	if !ok {
		return utilities.ID{}, utilities.ID{}, false
	}
	return tenantID, auditLogID, true
}
