package httpapi

import (
	"context"
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
	tenantID, spaceIDs, err := decodeSpaceIDList(r, episodes.MaximumLiveEpisodeSpaces, apiErrorInvalidSpaceIDs)
	return listSpaceLiveEpisodesRequest{TenantID: tenantID, SpaceIDs: spaceIDs}, err
}

// decodeSpaceIDList reads the tenant and the distinct comma-separated space_ids query value,
// and refuses more than limit IDs or any invalid or repeated ID with invalid.
func decodeSpaceIDList(r *http.Request, limit int, invalid APIError) (utilities.ID, []utilities.ID, error) {
	tenantID, err := tenantIDRequest(r)
	if err != nil {
		return utilities.ID{}, nil, err
	}
	values := strings.Split(r.URL.Query().Get("space_ids"), ",")
	if len(values) > limit {
		return utilities.ID{}, nil, invalid
	}
	spaceIDs := make([]utilities.ID, 0, len(values))
	seen := make(map[utilities.ID]bool, len(values))
	for _, value := range values {
		id, err := utilities.ParseID(value)
		if err != nil || id.IsZero() || seen[id] {
			return utilities.ID{}, nil, invalid
		}
		seen[id] = true
		spaceIDs = append(spaceIDs, id)
	}
	return tenantID, spaceIDs, nil
}

func newPresentParticipantResponses(participants []episodes.PresentParticipant) []presentParticipantResponse {
	responses := make([]presentParticipantResponse, 0, len(participants))
	for _, participant := range participants {
		responses = append(responses, presentParticipantResponse{ParticipantID: participant.ParticipantID.String(), DisplayName: participant.DisplayName})
	}
	return responses
}

func newLiveEpisodeResponse(episode episodes.LiveEpisode, participantCount int) liveEpisodeResponse {
	return liveEpisodeResponse{EpisodeID: episode.EpisodeID.String(), ParticipantCount: participantCount, Participants: newPresentParticipantResponses(episode.Participants)}
}

func newSpaceLiveEpisodeListResponse(list []episodes.SpaceLiveEpisode) spaceLiveEpisodeListResponse {
	result := spaceLiveEpisodeListResponse{Spaces: make([]spaceLiveEpisodeResponse, 0, len(list))}
	for _, space := range list {
		item := spaceLiveEpisodeResponse{SpaceID: space.SpaceID.String()}
		if space.Episode != nil {
			live := newLiveEpisodeResponse(*space.Episode, len(space.Episode.Participants))
			item.LiveEpisode = &live
		}
		result.Spaces = append(result.Spaces, item)
	}
	return result
}

func listSpaceLiveEpisodesEndpoint(service EpisodeLifecycleService, authorizer TenantAuthorizer) Endpoint[listSpaceLiveEpisodesRequest, spaceLiveEpisodeListResponse] {
	return Get("/v1/tenants/{tenant_id}/live-episodes", "listSpaceLiveEpisodes", decodeListSpaceLiveEpisodesRequest, func(ctx context.Context, request listSpaceLiveEpisodesRequest) (spaceLiveEpisodeListResponse, error) {
		list, err := service.ListSpaceLiveEpisodes(ctx, request.TenantID, request.SpaceIDs)
		if err != nil {
			return spaceLiveEpisodeListResponse{}, err
		}
		return newSpaceLiveEpisodeListResponse(list), nil
	}).Permission(authorizer, readEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), APIParameterContract{Name: "space_ids", In: "query", Type: "string", Required: true}).
		Responds(http.StatusOK, "SpaceLiveEpisodeList", spaceLiveEpisodeListResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceIDs, apiErrorSpaceNotFound, apiErrorRateLimited)...).ErrorRules(errorRules{ruleFor(apiErrorInvalidSpaceIDs, episodes.ErrInvalidSpaceIDs)}, episodeLifecycleRules)
}
