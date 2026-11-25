package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type ParticipantLobbyService interface {
	GetEpisode(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.Episode, error)
	ListLobbyParticipants(context.Context, utilities.ID, utilities.ID) ([]episodes.LobbyParticipant, error)
}

type participantLobbyResponse struct {
	Participants []lobbyParticipantResponse `json:"participants"`
}

// A signed participant may read the privacy-limited roster before using its access to join.
func participantLobbyEndpoint(service ParticipantLobbyService, verifier ParticipantMediaVerifier) Endpoint[issueSyncTokenEndpointRequest, participantLobbyResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/participants/{participant_id}/lobby", "getParticipantLobby",
		decodeIssueSyncTokenRequest,
		func(ctx context.Context, route issueSyncTokenEndpointRequest) (participantLobbyResponse, error) {
			subject, ok := accessgrants.SubjectFromContext(ctx)
			if !ok {
				return participantLobbyResponse{}, apiErrorUnauthenticated
			}
			if subject.TenantID != route.TenantID || subject.SpaceID != route.SpaceID || subject.EpisodeID != route.EpisodeID || subject.ParticipantID != route.ParticipantID {
				return participantLobbyResponse{}, apiErrorForbidden
			}
			episode, err := service.GetEpisode(ctx, subject.TenantID, subject.SpaceID, subject.EpisodeID)
			if err != nil {
				return participantLobbyResponse{}, err
			}
			if episode.Status != episodes.EpisodeStatusActive && episode.Status != episodes.EpisodeStatusEnding {
				return participantLobbyResponse{}, apiErrorEpisodeNotActive
			}
			participants, err := service.ListLobbyParticipants(ctx, subject.TenantID, subject.SpaceID)
			if err != nil {
				return participantLobbyResponse{}, err
			}
			visible := make([]episodes.LobbyParticipant, 0, len(participants))
			for _, participant := range participants {
				if participant.ParticipantID != subject.ParticipantID {
					visible = append(visible, participant)
				}
			}
			return participantLobbyResponse{Participants: newEpisodeLobbyParticipantResponse(visible)}, nil
		}).Needs(service).Auth(APIAuthParticipantMedia).Middleware(requireParticipantMediaCredential(verifier), noStoreParticipantEpisodeStatus).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter(), participantIDParameter()).
		Responds(http.StatusOK, "ParticipantLobby", participantLobbyResponse{}).
		Errors(lifecycleReadErrors(apiErrorRateLimited, apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorInvalidParticipantID, apiErrorEpisodeNotFound, apiErrorEpisodeNotActive)...).
		ErrorRules(episodeLifecycleRules)
}

func newEpisodeLobbyParticipantResponse(participants []episodes.LobbyParticipant) []lobbyParticipantResponse {
	result := make([]lobbyParticipantResponse, 0, len(participants))
	for _, participant := range participants {
		result = append(result, lobbyParticipantResponse{DisplayName: participant.DisplayName, IdentityKind: participant.IdentityKind, Notice: agentNotice(participant.IdentityKind, participant.Notice)})
	}
	return result
}
