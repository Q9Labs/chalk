package httpapi

import (
	"context"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var readFocusPermission = authorization.TenantPermission{Scope: authentication.ScopeFocusRead, MinimumRole: memberships.RoleObserver}

type focusIntervalResponse struct {
	State     string `json:"state"`
	Windowed  bool   `json:"windowed"`
	StartedAt string `json:"started_at"`
	EndedAt   string `json:"ended_at"`
}

type focusStepAwayResponse struct {
	Reason    string  `json:"reason"`
	StartedAt string  `json:"started_at"`
	EndedAt   *string `json:"ended_at"`
}

type focusAllowWindowResponse struct {
	ActorParticipantID string  `json:"actor_participant_id"`
	StartedAt          string  `json:"started_at"`
	EndsAt             string  `json:"ends_at"`
	EndedAt            *string `json:"ended_at"`
}

type focusParticipantResponse struct {
	ParticipantID            string                  `json:"participant_id"`
	DisplayName              string                  `json:"display_name"`
	Intervals                []focusIntervalResponse `json:"intervals"`
	StepAways                []focusStepAwayResponse `json:"step_aways"`
	AwayTimeSeconds          int64                   `json:"away_time_seconds"`
	TimesAway                int                     `json:"times_away"`
	LongestAwaySeconds       int64                   `json:"longest_away_seconds"`
	ReportingCoverageSeconds int64                   `json:"reporting_coverage_seconds"`
	ReportingCoverageRatio   float64                 `json:"reporting_coverage_ratio"`
}

type episodeFocusResponse struct {
	EpisodeID    string                     `json:"episode_id"`
	Participants []focusParticipantResponse `json:"participants"`
	AllowWindows []focusAllowWindowResponse `json:"allow_windows"`
}

type episodeFocusService interface {
	GetEpisodeFocus(context.Context, utilities.ID, utilities.ID, utilities.ID) (episodes.FocusArtifact, error)
}

func getEpisodeFocusEndpoint(service episodeFocusService, authorizer TenantAuthorizer) Endpoint[getEpisodeRequest, episodeFocusResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/focus", "getEpisodeFocus", decodeGetEpisodeRequest, func(ctx context.Context, request getEpisodeRequest) (episodeFocusResponse, error) {
		artifact, err := service.GetEpisodeFocus(ctx, request.TenantID, request.SpaceID, request.EpisodeID)
		if err != nil {
			return episodeFocusResponse{}, err
		}
		return newEpisodeFocusResponse(artifact), nil
	}).Permission(authorizer, readFocusPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter()).Responds(http.StatusOK, "EpisodeFocus", episodeFocusResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorEpisodeNotFound, apiErrorRateLimited)...).ErrorRules(episodeLifecycleRules)
}

func newEpisodeFocusResponse(artifact episodes.FocusArtifact) episodeFocusResponse {
	response := episodeFocusResponse{EpisodeID: artifact.EpisodeID.String(), Participants: make([]focusParticipantResponse, 0, len(artifact.Participants)), AllowWindows: make([]focusAllowWindowResponse, 0, len(artifact.AllowWindows))}
	for _, window := range artifact.AllowWindows {
		response.AllowWindows = append(response.AllowWindows, focusAllowWindowResponse{
			ActorParticipantID: window.ActorParticipantID.String(), StartedAt: utilities.FormatTimestamp(window.StartedAt), EndsAt: utilities.FormatTimestamp(window.EndsAt), EndedAt: optionalTimestampString(window.EndedAt),
		})
	}
	for _, participant := range artifact.Participants {
		away := episodes.FocusAwayIntervals(participant.Intervals, artifact.AllowWindows, participant.EpisodeEndsAt)
		var awaySeconds, longest int64
		for _, interval := range away {
			duration := int64(interval.EndedAt.Sub(interval.StartedAt).Seconds())
			awaySeconds += duration
			if duration > longest {
				longest = duration
			}
		}
		reported := episodes.FocusReportedSeconds(participant.Intervals)
		episodeSeconds := int64(participant.EpisodeEndsAt.Sub(participant.EpisodeStartsAt).Seconds())
		coverage := 0.0
		if episodeSeconds > 0 {
			coverage = float64(reported) / float64(episodeSeconds)
			if coverage > 1 {
				coverage = 1
			}
		}
		item := focusParticipantResponse{
			ParticipantID: participant.ParticipantID.String(), DisplayName: participant.DisplayName,
			Intervals: make([]focusIntervalResponse, 0, len(participant.Intervals)), StepAways: make([]focusStepAwayResponse, 0, len(participant.StepAways)),
			AwayTimeSeconds: awaySeconds, TimesAway: len(away), LongestAwaySeconds: longest,
			ReportingCoverageSeconds: reported, ReportingCoverageRatio: coverage,
		}
		for _, interval := range participant.Intervals {
			item.Intervals = append(item.Intervals, focusIntervalResponse{State: interval.State, Windowed: interval.Windowed, StartedAt: utilities.FormatTimestamp(interval.StartedAt), EndedAt: utilities.FormatTimestamp(interval.EndedAt)})
		}
		for _, stepAway := range participant.StepAways {
			item.StepAways = append(item.StepAways, focusStepAwayResponse{Reason: stepAway.Reason, StartedAt: utilities.FormatTimestamp(stepAway.StartedAt), EndedAt: optionalTimestampString(stepAway.EndedAt)})
		}
		response.Participants = append(response.Participants, item)
	}
	return response
}
