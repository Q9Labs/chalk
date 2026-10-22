package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

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
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return listSpaceActivityRequest{}, err
	}
	values := strings.Split(r.URL.Query().Get("space_ids"), ",")
	if len(values) > episodes.MaximumActivitySpaces {
		return listSpaceActivityRequest{}, apiErrorInvalidActivitySpaceIDs
	}
	result := listSpaceActivityRequest{TenantID: tenantID, SpaceIDs: make([]utilities.ID, 0, len(values))}
	seen := make(map[utilities.ID]bool, len(values))
	for _, value := range values {
		id, err := utilities.ParseID(value)
		if err != nil || id.IsZero() || seen[id] {
			return listSpaceActivityRequest{}, apiErrorInvalidActivitySpaceIDs
		}
		seen[id] = true
		result.SpaceIDs = append(result.SpaceIDs, id)
	}
	return result, nil
}

func listSpaceActivityEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[listSpaceActivityRequest, spaceActivityListResponse] {
	return Get("/v1/tenants/{tenant_id}/space-activity", "/tenants/{tenant_id}/space-activity", "listSpaceActivity", decodeListSpaceActivityRequest, func(ctx context.Context, request listSpaceActivityRequest) (spaceActivityListResponse, error) {
		if err := authorizeTenant(ctx, authorizer, request.TenantID, readEpisodesPermission); err != nil {
			return spaceActivityListResponse{}, err
		}
		if service == nil {
			return spaceActivityListResponse{}, apiErrorServiceUnavailable
		}
		list, err := service.ListSpaceActivity(ctx, request.TenantID, request.SpaceIDs)
		if err != nil {
			return spaceActivityListResponse{}, err
		}
		result := spaceActivityListResponse{Spaces: make([]spaceActivityResponse, 0, len(list))}
		for _, space := range list {
			item := spaceActivityResponse{SpaceID: space.SpaceID.String(), RecentParticipants: make([]presentParticipantResponse, 0, len(space.RecentParticipants))}
			if latest := space.LatestEpisode; latest != nil {
				item.LatestEpisode = &latestEpisodeResponse{EpisodeID: latest.EpisodeID.String(), Status: latest.Status, StartedAt: episodeTimestampString(latest.StartedAt)}
				if latest.EndedAt != nil {
					value := episodeTimestampString(*latest.EndedAt)
					item.LatestEpisode.EndedAt = &value
				}
			}
			for _, participant := range space.RecentParticipants {
				item.RecentParticipants = append(item.RecentParticipants, presentParticipantResponse{ParticipantID: participant.ParticipantID.String(), DisplayName: participant.DisplayName})
			}
			if space.LiveEpisode != nil {
				live := liveEpisodeResponse{EpisodeID: space.LiveEpisode.EpisodeID.String(), ParticipantCount: space.LiveParticipantCount, Participants: make([]presentParticipantResponse, 0, len(space.LiveEpisode.Participants))}
				for _, participant := range space.LiveEpisode.Participants {
					live.Participants = append(live.Participants, presentParticipantResponse{ParticipantID: participant.ParticipantID.String(), DisplayName: participant.DisplayName})
				}
				item.LiveEpisode = &live
			}
			result.Spaces = append(result.Spaces, item)
		}
		return result, nil
	}).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), APIParameterContract{Name: "space_ids", In: "query", Type: "string", Required: true}).
		Responds(http.StatusOK, "SpaceActivityList", spaceActivityListResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidActivitySpaceIDs, apiErrorSpaceNotFound, apiErrorRateLimited)...).MapErrors(func(err error) (APIError, bool) {
		if errors.Is(err, episodes.ErrInvalidActivitySpaceIDs) {
			return apiErrorInvalidActivitySpaceIDs, true
		}
		return episodeLifecycleEndpointAPIError(err)
	})
}
