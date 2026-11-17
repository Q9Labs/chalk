package httpapi

import (
	"context"
	"fmt"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/talktime"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type EpisodeTalkTimeService interface {
	Get(context.Context, utilities.ID, utilities.ID, utilities.ID) (talktime.Outcome, error)
}

const (
	talkTimeSourceTranscript = "transcript"

	talkTimeStatusAvailable         = "available"
	talkTimeStatusNoTranscript      = "no_transcript"
	talkTimeStatusTranscriptPending = "transcript_pending"
	talkTimeStatusLive              = "live"
)

// episodeTalkTimeResponse is a discriminated union on status: talk_time is set
// when status is "available" and null for every other status.
type episodeTalkTimeResponse struct {
	EpisodeID string            `json:"episode_id"`
	Source    string            `json:"source"`
	Status    string            `json:"status"`
	TalkTime  *talkTimeResponse `json:"talk_time"`
}

type talkTimeResponse struct {
	EpisodeDurationMS  int64                   `json:"episode_duration_ms"`
	TotalTalkMS        int64                   `json:"total_talk_ms"`
	OverlapMS          int64                   `json:"overlap_ms"`
	SilenceMS          int64                   `json:"silence_ms"`
	BucketMS           int64                   `json:"bucket_ms"`
	IntervalsTruncated bool                    `json:"intervals_truncated"`
	Recordings         []talkTimeRecordingBody `json:"recordings"`
	Speakers           []talkTimeSpeakerBody   `json:"speakers"`
}

type talkTimeRecordingBody struct {
	RecordingID string `json:"recording_id"`
	OffsetMS    int64  `json:"offset_ms"`
	Transcribed bool   `json:"transcribed"`
}

type talkTimeSpeakerBody struct {
	SpeakerKey    string                 `json:"speaker_key"`
	ParticipantID *string                `json:"participant_id"`
	DisplayName   string                 `json:"display_name"`
	TalkMS        int64                  `json:"talk_ms"`
	Share         float64                `json:"share"`
	Turns         int                    `json:"turns"`
	Intervals     []talkTimeIntervalBody `json:"intervals"`
	BucketTalkMS  []int64                `json:"bucket_talk_ms"`
}

type talkTimeIntervalBody struct {
	StartMS int64 `json:"start_ms"`
	EndMS   int64 `json:"end_ms"`
}

func getEpisodeTalkTimeEndpoint(service EpisodeTalkTimeService, authorizer TenantAuthorizer) Endpoint[getEpisodeRequest, episodeTalkTimeResponse] {
	return Get("/v1/tenants/{tenant_id}/spaces/{space_id}/episodes/{episode_id}/talk-time", "getEpisodeTalkTime", decodeGetEpisodeRequest, func(ctx context.Context, request getEpisodeRequest) (episodeTalkTimeResponse, error) {
		outcome, err := service.Get(ctx, request.TenantID, request.SpaceID, request.EpisodeID)
		if err != nil {
			return episodeTalkTimeResponse{}, err
		}
		return newEpisodeTalkTimeResponse(request.EpisodeID, outcome)
	}).Permission(authorizer, readEpisodesPermission).Needs(service).Auth(APIAuthSessionOrBearer).RateLimit(authenticatedReadRateLimit).
		Description("Who spoke in an ended Episode and for how long, measured from its complete transcripts: talk time and share per Participant, speech runs, overlap and silence, and a fixed-bucket timeline. status says whether a measurement exists; talk_time is set only when it is \"available\". Speech runs are capped, and intervals_truncated says when they were left out. Requires episodes:read.").
		Parameters(tenantIDParameter(), spaceIDParameter(), episodeIDParameter()).Responds(http.StatusOK, "EpisodeTalkTime", episodeTalkTimeResponse{}).
		Errors(lifecycleReadErrors(apiErrorInvalidSpaceID, apiErrorInvalidEpisodeID, apiErrorEpisodeNotFound, apiErrorRateLimited)...).ErrorRules(episodeLifecycleRules)
}

func newEpisodeTalkTimeResponse(episodeID utilities.ID, outcome talktime.Outcome) (episodeTalkTimeResponse, error) {
	response := episodeTalkTimeResponse{EpisodeID: episodeID.String(), Source: talkTimeSourceTranscript}
	switch outcome := outcome.(type) {
	case talktime.Available:
		response.Status = talkTimeStatusAvailable
		response.TalkTime = newTalkTimeResponse(outcome)
	case talktime.NoTranscript:
		response.Status = talkTimeStatusNoTranscript
	case talktime.TranscriptPending:
		response.Status = talkTimeStatusTranscriptPending
	case talktime.Live:
		response.Status = talkTimeStatusLive
	default:
		return episodeTalkTimeResponse{}, fmt.Errorf("unknown talk time outcome %T", outcome)
	}
	return response, nil
}

func newTalkTimeResponse(available talktime.Available) *talkTimeResponse {
	report := available.Report
	response := &talkTimeResponse{
		EpisodeDurationMS: report.EpisodeDurationMS, TotalTalkMS: report.TotalTalkMS, OverlapMS: report.OverlapMS, SilenceMS: report.SilenceMS,
		BucketMS: report.BucketMS, IntervalsTruncated: report.IntervalsTruncated,
		Recordings: make([]talkTimeRecordingBody, 0, len(available.Recordings)),
		Speakers:   make([]talkTimeSpeakerBody, 0, len(report.Speakers)),
	}
	for _, recording := range available.Recordings {
		response.Recordings = append(response.Recordings, talkTimeRecordingBody{RecordingID: recording.RecordingID.String(), OffsetMS: recording.OffsetMS, Transcribed: recording.Transcribed})
	}
	for _, speaker := range report.Speakers {
		body := talkTimeSpeakerBody{
			SpeakerKey: speaker.ID, DisplayName: speaker.DisplayName, TalkMS: speaker.TalkMS, Share: speaker.Share, Turns: speaker.Turns,
			Intervals: make([]talkTimeIntervalBody, 0, len(speaker.Intervals)), BucketTalkMS: speaker.BucketTalkMS,
		}
		if speaker.ParticipantID != "" {
			participantID := speaker.ParticipantID
			body.ParticipantID = &participantID
		}
		for _, interval := range speaker.Intervals {
			body.Intervals = append(body.Intervals, talkTimeIntervalBody{StartMS: interval.StartMS, EndMS: interval.EndMS})
		}
		response.Speakers = append(response.Speakers, body)
	}
	return response
}
