package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func decodeCreateTenantHandoverRequest(r *http.Request) (createTenantHandoverEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return createTenantHandoverEndpointRequest{}, err
	}
	key := r.Header.Get(idempotencyKeyHeader)
	body, err := decodeJSONBody[createTenantHandoverRequest](r)
	if err != nil {
		return createTenantHandoverEndpointRequest{}, err
	}
	return createTenantHandoverEndpointRequest{TenantID: tenantID, RequestKey: key, Body: body}, nil
}
func decodeTenantHandoverRequest(r *http.Request) (tenantHandoverEndpointRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return tenantHandoverEndpointRequest{}, err
	}
	id, err := tenantHandoverIDRequest(r)
	if err != nil {
		return tenantHandoverEndpointRequest{}, err
	}
	return tenantHandoverEndpointRequest{TenantID: tenantID, HandoverID: id}, nil
}
func decodeAcceptanceTenantHandoverRequest(r *http.Request) (acceptTenantHandoverEndpointRequest, error) {
	id, err := tenantHandoverIDRequest(r)
	return acceptTenantHandoverEndpointRequest{HandoverID: id}, err
}
func decodeAcceptTenantHandoverRequest(r *http.Request) (acceptTenantHandoverEndpointRequest, error) {
	id, err := tenantHandoverIDRequest(r)
	if err != nil {
		return acceptTenantHandoverEndpointRequest{}, err
	}
	body, err := decodeJSONBody[acceptTenantHandoverRequest](r)
	if err != nil {
		return acceptTenantHandoverEndpointRequest{}, err
	}
	return acceptTenantHandoverEndpointRequest{HandoverID: id, Body: body}, nil
}
func decodeLatestAcceptedTenantHandoverRequest(r *http.Request) (latestAcceptedTenantHandoverRequest, error) {
	return latestAcceptedTenantHandoverRequest{Email: r.URL.Query().Get("recipient_email")}, nil
}

func tenantHandoverIDRequest(r *http.Request) (utilities.ID, error) {
	id, err := utilities.ParseID(chi.URLParam(r, "handover_id"))
	if err != nil {
		return utilities.ID{}, apiErrorInvalidTenantHandoverID
	}
	return id, nil
}
func tenantHandoverIDParameter() APIParameterContract {
	return APIParameterContract{Name: "handover_id", In: "path", Type: "string", Required: true}
}
