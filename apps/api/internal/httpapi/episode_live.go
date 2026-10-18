package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type presentParticipantResponse struct {
	ParticipantID string `json:"participant_id"`
	DisplayName   string `json:"display_name"`
}

type liveEpisodeResponse struct {
	EpisodeID        string                       `json:"episode_id"`
	ParticipantCount int                          `json:"participant_count"`
	Participants     []presentParticipantResponse `json:"participants"`
}

type spaceLiveEpisodeResponse struct {
	SpaceID     string               `json:"space_id"`
	LiveEpisode *liveEpisodeResponse `json:"live_episode"`
}

type spaceLiveEpisodeListResponse struct {
	Spaces []spaceLiveEpisodeResponse `json:"spaces"`
}

type listSpaceLiveEpisodesRequest struct {
	TenantID utilities.ID
	SpaceIDs []utilities.ID
}

var apiErrorInvalidSpaceIDs = APIError{Status: http.StatusBadRequest, Code: "episode.invalid_space_ids", Message: "Provide 1 to 30 distinct comma-separated Space IDs"}

func decodeListSpaceLiveEpisodesRequest(r *http.Request) (listSpaceLiveEpisodesRequest, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listSpaceLiveEpisodesRequest{}, err
	}
	values := strings.Split(r.URL.Query().Get("space_ids"), ",")
	if len(values) > episodes.MaximumLiveEpisodeSpaces {
		return listSpaceLiveEpisodesRequest{}, apiErrorInvalidSpaceIDs
	}
	result := listSpaceLiveEpisodesRequest{TenantID: tenantID, SpaceIDs: make([]utilities.ID, 0, len(values))}
	seen := make(map[utilities.ID]bool, len(values))
	for _, value := range values {
		id, err := utilities.ParseID(value)
		if err != nil || id.IsZero() || seen[id] {
			return listSpaceLiveEpisodesRequest{}, apiErrorInvalidSpaceIDs
		}
		seen[id] = true
		result.SpaceIDs = append(result.SpaceIDs, id)
	}
	return result, nil
}

func listSpaceLiveEpisodesEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[listSpaceLiveEpisodesRequest, spaceLiveEpisodeListResponse] {
	return Get("/v1/tenants/{tenant_id}/live-episodes", "/tenants/{tenant_id}/live-episodes", "listSpaceLiveEpisodes", decodeListSpaceLiveEpisodesRequest, func(ctx context.Context, request listSpaceLiveEpisodesRequest) (spaceLiveEpisodeListResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readEpisodesPermission); err != nil {
			return spaceLiveEpisodeListResponse{}, err
		}
		if service == nil {
			return spaceLiveEpisodeListResponse{}, apiErrorServiceUnavailable
		}
		list, err := service.ListSpaceLiveEpisodes(ctx, request.TenantID, request.SpaceIDs)
		if err != nil {
			return spaceLiveEpisodeListResponse{}, err
		}
		result := spaceLiveEpisodeListResponse{Spaces: make([]spaceLiveEpisodeResponse, 0, len(list))}
		for _, space := range list {
			item := spaceLiveEpisodeResponse{SpaceID: space.SpaceID.String()}
			if space.Episode != nil {
				live := liveEpisodeResponse{EpisodeID: space.Episode.EpisodeID.String(), ParticipantCount: len(space.Episode.Participants), Participants: make([]presentParticipantResponse, 0, len(space.Episode.Participants))}
				for _, participant := range space.Episode.Participants {
					live.Participants = append(live.Participants, presentParticipantResponse{ParticipantID: participant.ParticipantID.String(), DisplayName: participant.DisplayName})
				}
				item.LiveEpisode = &live
			}
			result.Spaces = append(result.Spaces, item)
		}
		return result, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), APIParameterContract{Name: "space_ids", In: "query", Type: "string", Required: true}).
		Responds(http.StatusOK, "SpaceLiveEpisodeList", spaceLiveEpisodeListResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceIDs, apiErrorSpaceNotFound, apiErrorRateLimited)...).MapErrors(func(err error) (APIError, bool) {
		if errors.Is(err, episodes.ErrInvalidSpaceIDs) {
			return apiErrorInvalidSpaceIDs, true
		}
		return episodeLifecycleEndpointAPIError(err)
	})
}
