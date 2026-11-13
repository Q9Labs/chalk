package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recorderCaptureSignalingAuthorityBody struct {
	SignalingHandle   string `json:"signaling_handle"`
	TenantID          string `json:"tenant_id"`
	SpaceID           string `json:"space_id"`
	EpisodeID         string `json:"episode_id"`
	RecordingID       string `json:"recording_id"`
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
	LeaseToken        string `json:"lease_token"`
	LeaseExpiresAt    string `json:"lease_expires_at"`
	PlanRevision      int64  `json:"plan_revision"`
	IdempotencyKey    string `json:"idempotency_key"`
}

type recorderCaptureCreateBody struct {
	recorderCaptureSignalingAuthorityBody
}

type recorderCapturePullBody struct {
	recorderCaptureSignalingAuthorityBody
	Connection       string                     `json:"connection"`
	Tracks           []recorderCaptureTrackBody `json:"tracks"`
	LocalDescription *captureplane.Description  `json:"local_description,omitempty"`
}

type recorderCaptureRenegotiateBody struct {
	recorderCaptureSignalingAuthorityBody
	Connection    string                   `json:"connection"`
	NegotiationID string                   `json:"negotiation_id"`
	Description   captureplane.Description `json:"description"`
}

type recorderCaptureInspectBody struct {
	recorderCaptureSignalingAuthorityBody
	Connection string                           `json:"connection"`
	Tracks     []recorderCapturePulledTrackBody `json:"tracks,omitempty"`
}

type recorderCaptureCloseTracksBody struct {
	recorderCaptureSignalingAuthorityBody
	Connection string                           `json:"connection"`
	Tracks     []recorderCapturePulledTrackBody `json:"tracks"`
}

type recorderCaptureCloseConnectionBody struct {
	recorderCaptureSignalingAuthorityBody
	Connection string                           `json:"connection"`
	Tracks     []recorderCapturePulledTrackBody `json:"tracks,omitempty"`
	Force      bool                             `json:"force"`
}

type recorderCaptureTrackBody struct {
	OwnerReference        string `json:"owner_reference"`
	TrackReference        string `json:"track_reference"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
	Source                string `json:"source"`
	Kind                  string `json:"kind"`
	RequestedLayer        string `json:"requested_layer"`
}

type recorderCapturePulledTrackBody struct {
	OwnerReference        string `json:"owner_reference"`
	TrackReference        string `json:"track_reference"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
	Source                string `json:"source"`
	Kind                  string `json:"kind"`
	RequestedLayer        string `json:"requested_layer"`
	MID                   string `json:"mid"`
}

type recorderCaptureSignalingResponse struct {
	Replayed bool                           `json:"replayed"`
	Result   capturesignaling.CommandResult `json:"result"`
}

func recorderCaptureTracks(values []recorderCaptureTrackBody) ([]captureplane.CaptureTrack, error) {
	tracks := make([]captureplane.CaptureTrack, 0, len(values))
	for _, value := range values {
		owner, err := captureplane.NewProviderReference(value.OwnerReference)
		track, trackErr := captureplane.NewProviderReference(value.TrackReference)
		participantID, participantErr := utilities.ParseID(value.ParticipantID)
		if err != nil || trackErr != nil || participantErr != nil {
			return nil, capturesignaling.ErrInvalidCommand
		}
		tracks = append(tracks, captureplane.CaptureTrack{
			OwnerReference: owner, TrackReference: track, ParticipantID: participantID,
			ParticipantGeneration: value.ParticipantGeneration, Source: captureplane.TrackSource(value.Source),
			Kind: captureplane.TrackKind(value.Kind), RequestedLayer: captureplane.TrackLayer(value.RequestedLayer),
		})
	}
	return tracks, nil
}

func recorderCapturePulledTracks(values []recorderCapturePulledTrackBody) ([]captureplane.PulledCaptureTrack, error) {
	tracks := make([]captureplane.PulledCaptureTrack, 0, len(values))
	for _, value := range values {
		owner, err := captureplane.NewProviderReference(value.OwnerReference)
		track, trackErr := captureplane.NewProviderReference(value.TrackReference)
		mid, midErr := captureplane.NewProviderReference(value.MID)
		participantID, participantErr := utilities.ParseID(value.ParticipantID)
		if err != nil || trackErr != nil || midErr != nil || participantErr != nil {
			return nil, capturesignaling.ErrInvalidCommand
		}
		tracks = append(tracks, captureplane.PulledCaptureTrack{CaptureTrack: captureplane.CaptureTrack{
			OwnerReference: owner, TrackReference: track, ParticipantID: participantID,
			ParticipantGeneration: value.ParticipantGeneration, Source: captureplane.TrackSource(value.Source),
			Kind: captureplane.TrackKind(value.Kind), RequestedLayer: captureplane.TrackLayer(value.RequestedLayer),
		}, MID: mid})
	}
	return tracks, nil
}

func decodeRecorderCaptureSignalingBody[T any](w http.ResponseWriter, request *http.Request) (T, bool) {
	var body T
	request.Body = http.MaxBytesReader(w, request.Body, recorderCaptureSignalingBodyLimit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return body, false
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return body, false
	}
	return body, true
}

func writeRecorderCaptureSignalingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, capturesignaling.ErrInvalidInput), errors.Is(err, capturesignaling.ErrInvalidCommand):
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid capture signaling command")
	case errors.Is(err, capturesignaling.ErrTimeout):
		writeError(w, http.StatusGatewayTimeout, "recording.capture_signaling_timeout", "Capture signaling timed out")
	case errors.Is(err, capturesignaling.ErrAmbiguousOutcome):
		writeError(w, http.StatusConflict, "recording.capture_outcome_ambiguous", "Capture signaling outcome is ambiguous")
	case errors.Is(err, capturesignaling.ErrMediaStopped):
		writeError(w, http.StatusConflict, "recording.capture_media_stopped", "Capture media stopped or reached its deadline")
	case errors.Is(err, capturesignaling.ErrConflict), errors.Is(err, capturesignaling.ErrStaleAuthority),
		errors.Is(err, capturesignaling.ErrStaleLease), errors.Is(err, capturesignaling.ErrStaleCaptureEpoch),
		errors.Is(err, capturesignaling.ErrStalePlanRevision), errors.Is(err, capturesignaling.ErrStaleConnection),
		errors.Is(err, capturesignaling.ErrNegotiationMismatch):
		writeError(w, http.StatusConflict, "recording.capture_signaling_fenced", "Capture signaling authority is stale")
	case errors.Is(err, capturesignaling.ErrProviderFailure):
		writeError(w, http.StatusBadGateway, "recording.capture_provider_failed", "Capture provider command failed")
	case errors.Is(err, capturesignaling.ErrUnavailable):
		writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Capture signaling is unavailable")
	default:
		writeError(w, http.StatusInternalServerError, "internal.error", "Capture signaling failed")
	}
}
