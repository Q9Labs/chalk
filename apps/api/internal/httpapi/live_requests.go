package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/liverequests"
	"github.com/q9labs/chalk/apps/api/internal/obs"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// LiveRequestService creates one durable live-introspection request. Sync delivers
// it; the route only commits the row that the notification trigger fires on.
type LiveRequestService interface {
	Create(context.Context, liverequests.Input) (liverequests.Request, error)
}

var (
	apiErrorLiveRequestPending    = APIError{Status: http.StatusConflict, Code: "live.request_pending", Message: "A live introspection request is already pending for the seat"}
	apiErrorLiveRequestRateLimit  = APIError{Status: http.StatusTooManyRequests, Code: "live.rate_limited", Message: "Too many live introspection requests for the Episode"}
	apiErrorLiveRequestEpisode    = APIError{Status: http.StatusNotFound, Code: "live.episode_not_found", Message: "The Episode was not found"}
	apiErrorLiveRequestIDGenerate = APIError{Status: http.StatusServiceUnavailable, Code: "live.id_generation", Message: "Could not mint a request id"}
)

type liveRequestBody struct {
	TenantID      string `json:"tenant_id"`
	EpisodeID     string `json:"episode_id"`
	ParticipantID string `json:"participant_id"`
}

// operatorDiagnoseAuthorized compares the request's bearer hash against the
// configured hash, constant time on equal-length hashes.
func operatorDiagnoseAuthorized(r *http.Request, expected []byte) bool {
	if len(expected) != sha256.Size {
		return false
	}
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		return false
	}
	actual := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(actual[:], expected) == 1
}

// handleLiveRequestPost creates one live-introspection request. The route is
// unversioned like /healthz; with no operator diagnose token configured it
// answers 404 so the operator surface is closed by default.
func handleLiveRequestPost(service LiveRequestService, tokenSHA256 []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if len(tokenSHA256) != sha256.Size {
			writeError(w, http.StatusNotFound, "route.not_found", "Route not found")
			return
		}
		if !operatorDiagnoseAuthorized(r, tokenSHA256) {
			obs.Decision(r.Context(), "live_request.create", "refused", "live.unauthenticated")
			writeError(w, http.StatusUnauthorized, "auth.unauthorized", "Unauthorized")
			return
		}
		body, err := decodeJSONBodyWithLimit[liveRequestBody](r, 4096)
		if err != nil {
			writeError(w, http.StatusBadRequest, "live.invalid_body", "Invalid request body")
			return
		}
		tenantID, err1 := utilities.ParseID(body.TenantID)
		episodeID, err2 := utilities.ParseID(body.EpisodeID)
		participantID, err3 := utilities.ParseID(body.ParticipantID)
		if err1 != nil || err2 != nil || err3 != nil {
			writeError(w, http.StatusBadRequest, "live.invalid_body", "tenant_id, episode_id and participant_id must be ids")
			return
		}
		requestID, err := utilities.NewID()
		if err != nil {
			writeError(w, apiErrorLiveRequestIDGenerate.Status, apiErrorLiveRequestIDGenerate.Code, apiErrorLiveRequestIDGenerate.Message)
			return
		}
		request, err := service.Create(r.Context(), liverequests.Input{
			ID:            requestID,
			TenantID:      tenantID,
			EpisodeID:     episodeID,
			ParticipantID: participantID,
		})
		subject := []slog.Attr{
			obs.F("tenant_id", tenantID.String()),
			obs.F("episode_id", episodeID.String()),
			obs.F("participant_id", participantID.String()),
			obs.F("live_request_id", requestID.String()),
		}
		refuse := func(err APIError, reason string) {
			obs.Decision(r.Context(), "live_request.create", "refused", reason, subject...)
			writeError(w, err.Status, err.Code, err.Message)
		}
		switch {
		case errors.Is(err, liverequests.ErrPending):
			refuse(apiErrorLiveRequestPending, "live.request_pending")
			return
		case errors.Is(err, liverequests.ErrRateLimited):
			refuse(apiErrorLiveRequestRateLimit, "live.rate_limited")
			return
		case errors.Is(err, liverequests.ErrEpisodeMissing):
			writeError(w, apiErrorLiveRequestEpisode.Status, apiErrorLiveRequestEpisode.Code, apiErrorLiveRequestEpisode.Message)
			return
		case err != nil:
			writeError(w, http.StatusInternalServerError, "live.request_failed", "The live request could not be stored")
			return
		}
		obs.Decision(r.Context(), "live_request.create", "created", "", append(subject,
			obs.F("participant_status", request.ParticipantStatus),
			obs.F("episode_status", request.EpisodeStatus))...)
		writeJSON(w, http.StatusAccepted, map[string]string{
			"request_id":         request.ID.String(),
			"requested_at":       request.RequestedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
			"expires_at":         request.ExpiresAt.UTC().Format("2006-01-02T15:04:05.000Z"),
			"participant_status": request.ParticipantStatus,
			"episode_status":     request.EpisodeStatus,
		})
	}
}
