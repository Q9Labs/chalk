package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

type participantEpisodeStatusResponse struct {
	Status string `json:"status"`
}

// A signed participant may read only its own Episode lifecycle, including after
// active-participant authorization has stopped admitting media during teardown.
func participantEpisodeStatusEndpoint(service EpisodeLookup, verifier ParticipantMediaVerifier) Endpoint[issueSyncTokenEndpointRequest, participantEpisodeStatusResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/episode-status",
		"/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/episode-status", "getParticipantEpisodeStatus",
		decodeIssueSyncTokenRequest,
		func(ctx context.Context, route issueSyncTokenEndpointRequest) (participantEpisodeStatusResponse, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return participantEpisodeStatusResponse{}, apiErrorUnauthenticated
			}
			if subject.TenantID != route.TenantID || subject.SpaceID != route.SpaceID || subject.EpisodeID != route.EpisodeID || subject.ParticipantID != route.ParticipantID {
				return participantEpisodeStatusResponse{}, apiErrorForbidden
			}
			if service == nil {
				return participantEpisodeStatusResponse{}, apiErrorServiceUnavailable
			}
			episode, err := service.GetEpisode(ctx, subject.TenantID, subject.SpaceID, subject.EpisodeID)
			if err != nil {
				return participantEpisodeStatusResponse{}, err
			}
			switch episode.Status {
			case episodes.EpisodeStatusActive, episodes.EpisodeStatusEnding, episodes.EpisodeStatusEnded:
				return participantEpisodeStatusResponse{Status: episode.Status}, nil
			default:
				return participantEpisodeStatusResponse{}, apiErrorServiceUnavailable
			}
		}).Auth(APIAuthParticipantMedia).Middleware(requireParticipantMediaCredential(verifier), noStoreParticipantEpisodeStatus).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter()).
		Responds(http.StatusOK, "ParticipantEpisodeStatus", participantEpisodeStatusResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound)...).
		MapErrors(episodeLifecycleEndpointAPIError)
}

func noStoreParticipantEpisodeStatus(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}
