package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func decodeListTenantsRequest(r *http.Request) (listTenantsRequest, error) {
	page, err := parsePageRequest(r)
	if err != nil {
		return listTenantsRequest{}, paginationAPIError(err)
	}
	return listTenantsRequest{Page: page}, nil
}

func decodeGetTenantRequest(r *http.Request) (getTenantRequest, error) {
	tenantID, err := tenantIDFromRequest(r)
	if err != nil {
		return getTenantRequest{}, err
	}
	return getTenantRequest{TenantID: tenantID}, nil
}

func decodeUpdateTenantRequest(r *http.Request) (updateTenantEndpointRequest, error) {
	tenantID, err := tenantIDFromRequest(r)
	if err != nil {
		return updateTenantEndpointRequest{}, err
	}

	body, err := decodeUpdateTenantBody(r)
	if err != nil {
		return updateTenantEndpointRequest{}, err
	}

	return updateTenantEndpointRequest{TenantID: tenantID, Body: body}, nil
}

// Service credentials can manage dashboard preferences, not other Tenant settings.
// Check field presence before decoding, including nulls and future fields.
func decodeUpdateTenantBody(r *http.Request) (updateTenantRequest, error) {
	principal, _ := authentication.PrincipalFromContext(r.Context())
	if principal.Kind != authentication.PrincipalService {
		return decodeJSONBody[updateTenantRequest](r)
	}
	fields, err := decodeJSONBody[map[string]json.RawMessage](r)
	if err != nil {
		return updateTenantRequest{}, err
	}
	var body updateTenantRequest
	for field := range fields {
		if field != "cors_allowed_origins" && field != "recording_render_mode" && field != "transcript_language" {
			return updateTenantRequest{}, apiErrorForbidden
		}
	}
	if value, ok := fields["cors_allowed_origins"]; ok {
		if err := json.Unmarshal(value, &body.CORSAllowedOrigins); err != nil {
			return updateTenantRequest{}, apiErrorInvalidRequest
		}
	}
	if value, ok := fields["recording_render_mode"]; ok {
		if err := json.Unmarshal(value, &body.RecordingRenderMode); err != nil {
			return updateTenantRequest{}, apiErrorInvalidRequest
		}
	}
	if value, ok := fields["transcript_language"]; ok {
		if err := json.Unmarshal(value, &body.TranscriptLanguage); err != nil {
			return updateTenantRequest{}, apiErrorInvalidRequest
		}
	}
	return body, nil
}

func tenantIDFromRequest(r *http.Request) (utilities.ID, error) {
	id, err := utilities.ParseID(chi.URLParam(r, "tenant_id"))
	if err != nil {
		return utilities.ID{}, apiErrorInvalidTenantID
	}
	return id, nil
}
