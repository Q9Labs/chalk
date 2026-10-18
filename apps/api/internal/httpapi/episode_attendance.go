package httpapi

import (
	"context"
	"net/http"
	"time"
)

type attendanceParticipantResponse struct {
	ParticipantID string     `json:"participant_id"`
	DisplayName   string     `json:"display_name"`
	IdentityKind  string     `json:"identity_kind"`
	ExternalID    *string    `json:"external_id"`
	FirstJoinedAt time.Time  `json:"first_joined_at"`
	LastLeftAt    *time.Time `json:"last_left_at"`
	LeftReason    *string    `json:"left_reason"`
}

type episodeAttendanceResponse struct {
	EpisodeID    string                          `json:"episode_id"`
	Participants []attendanceParticipantResponse `json:"participants"`
}

func getEpisodeAttendanceEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[getEpisodeRequest, episodeAttendanceResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/attendance", "/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/attendance", "getEpisodeAttendance", decodeGetEpisodeRequest, func(ctx context.Context, request getEpisodeRequest) (episodeAttendanceResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readEpisodesPermission); err != nil {
			return episodeAttendanceResponse{}, err
		}
		if service == nil {
			return episodeAttendanceResponse{}, apiErrorServiceUnavailable
		}
		participants, err := service.GetEpisodeAttendance(ctx, request.TenantID, request.SpaceID, request.EpisodeID)
		if err != nil {
			return episodeAttendanceResponse{}, err
		}
		result := episodeAttendanceResponse{EpisodeID: request.EpisodeID.String(), Participants: make([]attendanceParticipantResponse, 0, len(participants))}
		for _, participant := range participants {
			result.Participants = append(result.Participants, attendanceParticipantResponse{
				ParticipantID: participant.ParticipantID.String(), DisplayName: participant.DisplayName,
				IdentityKind: participant.IdentityKind, ExternalID: participant.ExternalID,
				FirstJoinedAt: participant.FirstJoinedAt, LastLeftAt: participant.LastLeftAt, LeftReason: participant.LeftReason,
			})
		}
		return result, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter()).Responds(http.StatusOK, "EpisodeAttendance", episodeAttendanceResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorEpisodeNotFound, apiErrorRateLimited)...).MapErrors(episodeLifecycleEndpointAPIError)
}
