package httpapi

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func routeID(r *http.Request, parameter string, invalid APIError) (utilities.ID, error) {
	id, err := utilities.ParseID(chi.URLParam(r, parameter))
	if err != nil {
		return utilities.ID{}, invalid
	}
	return id, nil
}

func optionalQueryIDValue(r *http.Request, name string) (utilities.ID, error) {
	value := strings.TrimSpace(r.URL.Query().Get(name))
	if value == "" {
		return utilities.ID{}, nil
	}

	id, err := utilities.ParseID(value)
	if err != nil {
		return utilities.ID{}, err
	}
	return id, nil
}

func tenantIDRequest(r *http.Request) (utilities.ID, error) {
	return routeID(r, "tenant_id", apiErrorInvalidTenantID)
}

func userIDRequest(r *http.Request) (utilities.ID, error) {
	return routeID(r, "user_id", apiErrorInvalidUserID)
}

func membershipIDRequest(r *http.Request) (utilities.ID, error) {
	return routeID(r, "membership_id", apiErrorInvalidMembershipID)
}

func spaceIDRequest(r *http.Request) (utilities.ID, error) {
	return routeID(r, "space_id", apiErrorInvalidSpaceID)
}

func episodeIDRequest(r *http.Request) (utilities.ID, error) {
	return routeID(r, "episode_id", apiErrorInvalidEpisodeID)
}

func tenantSpaceEpisodeIDsRequest(r *http.Request) (utilities.ID, utilities.ID, utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	spaceID, err := spaceIDRequest(r)
	if err != nil {
		return utilities.ID{}, utilities.ID{}, utilities.ID{}, err
	}
	episodeID, err := episodeIDRequest(r)
	return tenantID, spaceID, episodeID, err
}

func recordingIDRequest(r *http.Request) (utilities.ID, error) {
	return routeID(r, "recording_id", apiErrorInvalidRecordingID)
}

func transcriptIDRequest(r *http.Request) (utilities.ID, error) {
	return routeID(r, "transcript_id", apiErrorInvalidTranscriptID)
}

func auditLogIDRequest(r *http.Request) (utilities.ID, error) {
	return routeID(r, "audit_log_id", apiErrorInvalidAuditLogID)
}

func paginationParameters() []APIParameterContract {
	return []APIParameterContract{
		{Name: "page_size", In: "query", Type: "integer", Required: false},
		{Name: "cursor", In: "query", Type: "string", Required: false},
	}
}

func tenantIDParameter() APIParameterContract {
	return APIParameterContract{Name: "tenant_id", In: "path", Type: "string", Required: true}
}

func userIDParameter() APIParameterContract {
	return APIParameterContract{Name: "user_id", In: "path", Type: "string", Required: true}
}

func membershipIDParameter() APIParameterContract {
	return APIParameterContract{Name: "membership_id", In: "path", Type: "string", Required: true}
}

func spaceIDParameter() APIParameterContract {
	return APIParameterContract{Name: "space_id", In: "path", Type: "string", Required: true}
}

func episodeIDParameter() APIParameterContract {
	return APIParameterContract{Name: "episode_id", In: "path", Type: "string", Required: true}
}

func recordingIDParameter() APIParameterContract {
	return APIParameterContract{Name: "recording_id", In: "path", Type: "string", Required: true}
}

func transcriptIDParameter() APIParameterContract {
	return APIParameterContract{Name: "transcript_id", In: "path", Type: "string", Required: true}
}

func auditLogIDParameter() APIParameterContract {
	return APIParameterContract{Name: "audit_log_id", In: "path", Type: "string", Required: true}
}

func recordingIDQueryParameter() APIParameterContract {
	return APIParameterContract{Name: "recording_id", In: "query", Type: "string", Required: false}
}

func episodeIDQueryParameter() APIParameterContract {
	return APIParameterContract{Name: "episode_id", In: "query", Type: "string", Required: false}
}

func optionalRecordingIDQuery(r *http.Request) (utilities.ID, error) {
	id, err := optionalQueryIDValue(r, "recording_id")
	if err != nil {
		return utilities.ID{}, apiErrorInvalidRecordingID
	}
	return id, nil
}

func optionalEpisodeIDQuery(r *http.Request) (utilities.ID, error) {
	id, err := optionalQueryIDValue(r, "episode_id")
	if err != nil {
		return utilities.ID{}, apiErrorInvalidEpisodeID
	}
	return id, nil
}
