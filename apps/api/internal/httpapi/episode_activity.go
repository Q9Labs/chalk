package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type latestEpisodeResponse struct {
	EpisodeID string  `json:"episode_id"`
	Status    string  `json:"status"`
	StartedAt string  `json:"started_at"`
	EndedAt   *string `json:"ended_at"`
}

type spaceActivityResponse struct {
	SpaceID            string                       `json:"space_id"`
	Archived           bool                         `json:"archived"`
	LiveEpisode        *liveEpisodeResponse         `json:"live_episode"`
	LatestEpisode      *latestEpisodeResponse       `json:"latest_episode"`
	RecentParticipants []presentParticipantResponse `json:"recent_participants"`
}

type spaceActivityListResponse struct {
	Spaces []spaceActivityResponse `json:"spaces"`
}

type listSpaceActivityRequest struct {
	TenantID utilities.ID
	SpaceIDs []utilities.ID
}

var apiErrorInvalidActivitySpaceIDs = APIError{Status: http.StatusBadRequest, Code: "episode.invalid_space_ids", Message: "Provide 1 to 300 distinct comma-separated Space IDs"}

func decodeListSpaceActivityRequest(r *http.Request) (listSpaceActivityRequest, error) {
	tenantID, spaceIDs, err := decodeSpaceIDList(r, episodes.MaximumActivitySpaces, apiErrorInvalidActivitySpaceIDs)
	return listSpaceActivityRequest{TenantID: tenantID, SpaceIDs: spaceIDs}, err
}

func newSpaceActivityListResponse(list []episodes.SpaceActivity) spaceActivityListResponse {
	result := spaceActivityListResponse{Spaces: make([]spaceActivityResponse, 0, len(list))}
	for _, space := range list {
		item := spaceActivityResponse{SpaceID: space.SpaceID.String(), Archived: space.Archived, RecentParticipants: newPresentParticipantResponses(space.RecentParticipants)}
		if latest := space.LatestEpisode; latest != nil {
			item.LatestEpisode = &latestEpisodeResponse{EpisodeID: latest.EpisodeID.String(), Status: latest.Status, StartedAt: episodeTimestampString(latest.StartedAt)}
			if latest.EndedAt != nil {
				value := episodeTimestampString(*latest.EndedAt)
				item.LatestEpisode.EndedAt = &value
			}
		}
		if space.LiveEpisode != nil {
			live := newLiveEpisodeResponse(*space.LiveEpisode, space.LiveParticipantCount)
			item.LiveEpisode = &live
		}
		result.Spaces = append(result.Spaces, item)
	}
	return result
}

func listSpaceActivityEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[listSpaceActivityRequest, spaceActivityListResponse] {
	return Get("/v1/tenants/{tenant_id}/space-activity", "listSpaceActivity", decodeListSpaceActivityRequest, func(ctx context.Context, request listSpaceActivityRequest) (spaceActivityListResponse, error) {
		list, err := service.ListSpaceActivity(ctx, request.TenantID, request.SpaceIDs)
		if err != nil {
			return spaceActivityListResponse{}, err
		}
		return newSpaceActivityListResponse(list), nil
	}).Permission(authorizer, readEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), APIParameterContract{Name: "space_ids", In: "query", Type: "string", Required: true}).
		Responds(http.StatusOK, "SpaceActivityList", spaceActivityListResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidActivitySpaceIDs, apiErrorSpaceNotFound, apiErrorRateLimited)...).ErrorRules(errorRules{ruleFor(apiErrorInvalidActivitySpaceIDs, episodes.ErrInvalidActivitySpaceIDs)}, episodeLifecycleRules)
}
