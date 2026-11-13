package httpapi

import (
	"github.com/q9labs/chalk/apps/api/internal/providerbridge"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

type providerOperationRequest struct {
	Effect                provideroperations.Effect            `json:"effect"`
	TenantID              string                               `json:"tenant_id"`
	EpisodeID             string                               `json:"episode_id"`
	ParticipantID         *string                              `json:"participant_id,omitempty"`
	ParticipantGeneration *int64                               `json:"participant_generation,omitempty"`
	PublicationSource     *string                              `json:"publication_source,omitempty"`
	ControlRevision       *int64                               `json:"control_revision,omitempty"`
	RecordingID           *string                              `json:"recording_id,omitempty"`
	RecordingReservation  *providerRecordingReservationRequest `json:"recording_reservation,omitempty"`
}

type providerRecordingReservationRequest struct {
	SpaceID               string `json:"space_id"`
	ParticipantCount      int    `json:"participant_count"`
	MaxDurationSeconds    int    `json:"max_duration_seconds"`
	InputBitrateBPS       int64  `json:"input_bitrate_bps"`
	PolicySnapshotVersion string `json:"policy_snapshot_version"`
}

type providerOperationResponse struct {
	OperationID string                     `json:"operation_id"`
	Effect      provideroperations.Effect  `json:"effect"`
	Outcome     provideroperations.Outcome `json:"outcome"`
	Reason      string                     `json:"reason,omitempty"`
}

type providerObservationResponse struct {
	Incarnation  int64                         `json:"incarnation"`
	Sequence     int64                         `json:"sequence"`
	Publications []providerPublicationResponse `json:"publications"`
}

type providerPublicationResponse struct {
	ParticipantID string  `json:"participant_id"`
	Source        string  `json:"source"`
	Enabled       bool    `json:"enabled"`
	PublicationID *string `json:"publication_id"`
}

type providerObservationCursorResponse struct {
	Incarnation int64 `json:"incarnation"`
	Sequence    int64 `json:"sequence"`
}

type providerObservationPageResponse struct {
	Observations []providerObservationResponse      `json:"observations"`
	HasMore      bool                               `json:"has_more"`
	NextCursor   *providerObservationCursorResponse `json:"next_cursor"`
}

func newProviderOperationResponse(result providerbridge.Result) providerOperationResponse {
	return providerOperationResponse{
		OperationID: result.OperationID,
		Effect:      result.Effect,
		Outcome:     result.Outcome,
		Reason:      result.Reason,
	}
}

func newProviderObservationPageResponse(page provideroperations.ObservationPage) providerObservationPageResponse {
	response := providerObservationPageResponse{
		Observations: make([]providerObservationResponse, 0, len(page.Observations)),
		HasMore:      page.Next != nil,
	}
	for _, observation := range page.Observations {
		publications := make([]providerPublicationResponse, 0, len(observation.Publications))
		for _, publication := range observation.Publications {
			var publicationID *string
			if publication.PublicationID != "" {
				value := publication.PublicationID
				publicationID = &value
			}
			publications = append(publications, providerPublicationResponse{
				ParticipantID: publication.ParticipantID.String(),
				Source:        publication.Source,
				Enabled:       publication.Enabled,
				PublicationID: publicationID,
			})
		}
		response.Observations = append(response.Observations, providerObservationResponse{
			Incarnation:  observation.Incarnation,
			Sequence:     observation.Sequence,
			Publications: publications,
		})
	}
	if page.Next != nil {
		response.NextCursor = &providerObservationCursorResponse{
			Incarnation: page.Next.Incarnation,
			Sequence:    page.Next.Sequence,
		}
	}
	return response
}
