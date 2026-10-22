package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
)

type ParticipantJoinService interface {
	CancelParticipantJoin(context.Context, episodes.CancelParticipantJoinInput) (bool, error)
}

type cancelParticipantJoinRequest struct {
	Route      issueSyncTokenEndpointRequest
	Credential string
}

type cancelParticipantJoinResponse struct {
	Cancelled bool `json:"cancelled"`
}

// The signed grant authorizes only cancellation of its own pending generation.
// Do not require active authority: expired/cancelled retries must be idempotent.
func cancelParticipantJoinEndpoint(service ParticipantJoinService, verifier ParticipantMediaVerifier) Endpoint[cancelParticipantJoinRequest, cancelParticipantJoinResponse] {
	return Post("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/cancel-join",
		"/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/cancel-join", "cancelEpisodeParticipantJoin",
		func(r *http.Request) (cancelParticipantJoinRequest, error) {
			route, err := decodeIssueSyncTokenRequest(r)
			if err != nil {
				return cancelParticipantJoinRequest{}, err
			}
			credential, ok := bearerToken(r.Header.Get("Authorization"))
			if !ok {
				return cancelParticipantJoinRequest{}, apiErrorUnauthenticated
			}
			return cancelParticipantJoinRequest{Route: route, Credential: credential}, nil
		},
		func(ctx context.Context, request cancelParticipantJoinRequest) (cancelParticipantJoinResponse, error) {
			if service == nil || verifier == nil {
				return cancelParticipantJoinResponse{}, apiErrorServiceUnavailable
			}
			subject, err := verifier.Verify(ctx, request.Credential)
			if err != nil {
				if isParticipantMediaCredentialRejection(err) {
					return cancelParticipantJoinResponse{}, apiErrorUnauthenticated
				}
				return cancelParticipantJoinResponse{}, err
			}
			route := request.Route
			if subject.TenantID != route.TenantID || subject.SpaceID != route.SpaceID || subject.EpisodeID != route.EpisodeID || subject.ParticipantID != route.ParticipantID {
				return cancelParticipantJoinResponse{}, apiErrorForbidden
			}
			cancelled, err := service.CancelParticipantJoin(ctx, episodes.CancelParticipantJoinInput{
				TenantID: subject.TenantID, SpaceID: subject.SpaceID, EpisodeID: subject.EpisodeID,
				ParticipantID: subject.ParticipantID, ParticipantGeneration: subject.ParticipantGeneration, MediaConnectionID: subject.CloudflareConnectionID,
			})
			return cancelParticipantJoinResponse{Cancelled: cancelled}, err
		}).Auth(APIAuthParticipantMedia).RateLimit(authenticatedWriteRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter()).
		Responds(http.StatusOK, "ParticipantJoinCancellation", cancelParticipantJoinResponse{}).
		Errors(apiErrorInvalidRequest, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID,
			apiErrorUnauthenticated, apiErrorForbidden, apiErrorRateLimited, apiErrorServiceUnavailable)
}
