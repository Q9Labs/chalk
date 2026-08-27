package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const recorderCaptureSignalingBodyLimit = 2 << 20

type RecorderCaptureSignalingService interface {
	Execute(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error)
}

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

func mountRecorderCaptureSignalingRoutes(router interface {
	Post(string, http.HandlerFunc)
}, service RecorderCaptureSignalingService) {
	if service == nil {
		return
	}
	router.Post("/capture/create", recorderCaptureCreateHandler(service))
	router.Post("/capture/pull", recorderCapturePullHandler(service))
	router.Post("/capture/renegotiate", recorderCaptureRenegotiateHandler(service))
	router.Post("/capture/inspect", recorderCaptureInspectHandler(service))
	router.Post("/capture/close-tracks", recorderCaptureCloseTracksHandler(service))
	router.Post("/capture/close-connection", recorderCaptureCloseConnectionHandler(service))
}

func recorderCaptureCreateHandler(service RecorderCaptureSignalingService) http.HandlerFunc {
	return recorderCaptureSignalingHandler(service, func(w http.ResponseWriter, request *http.Request, identity workeridentity.Identity) (capturesignaling.Command, bool) {
		body, ok := decodeRecorderCaptureSignalingBody[recorderCaptureCreateBody](w, request)
		if !ok {
			return capturesignaling.Command{}, false
		}
		return recorderCaptureSignalingCommand(identity, body.recorderCaptureSignalingAuthorityBody, captureplane.OperationCreateCaptureConnection, capturesignaling.CommandInput{CreateCaptureConnection: &captureplane.CreateCaptureConnectionInput{}})
	})
}

func recorderCapturePullHandler(service RecorderCaptureSignalingService) http.HandlerFunc {
	return recorderCaptureSignalingHandler(service, func(w http.ResponseWriter, request *http.Request, identity workeridentity.Identity) (capturesignaling.Command, bool) {
		body, ok := decodeRecorderCaptureSignalingBody[recorderCapturePullBody](w, request)
		if !ok {
			return capturesignaling.Command{}, false
		}
		connection, err := captureplane.NewProviderReference(body.Connection)
		tracks, tracksErr := recorderCaptureTracks(body.Tracks)
		if err != nil || tracksErr != nil {
			return capturesignaling.Command{}, false
		}
		return recorderCaptureSignalingCommand(identity, body.recorderCaptureSignalingAuthorityBody, captureplane.OperationPullCaptureTracks, capturesignaling.CommandInput{PullCaptureTracks: &captureplane.PullCaptureTracksInput{Connection: connection, Tracks: tracks, LocalDescription: body.LocalDescription}})
	})
}

func recorderCaptureRenegotiateHandler(service RecorderCaptureSignalingService) http.HandlerFunc {
	return recorderCaptureSignalingHandler(service, func(w http.ResponseWriter, request *http.Request, identity workeridentity.Identity) (capturesignaling.Command, bool) {
		body, ok := decodeRecorderCaptureSignalingBody[recorderCaptureRenegotiateBody](w, request)
		if !ok {
			return capturesignaling.Command{}, false
		}
		connection, err := captureplane.NewProviderReference(body.Connection)
		negotiationID, negotiationErr := captureplane.NewProviderReference(body.NegotiationID)
		if err != nil || negotiationErr != nil {
			return capturesignaling.Command{}, false
		}
		return recorderCaptureSignalingCommand(identity, body.recorderCaptureSignalingAuthorityBody, captureplane.OperationRenegotiateCaptureConnection, capturesignaling.CommandInput{RenegotiateCaptureConnection: &captureplane.RenegotiateCaptureConnectionInput{Connection: connection, NegotiationID: negotiationID, Description: body.Description}})
	})
}

func recorderCaptureInspectHandler(service RecorderCaptureSignalingService) http.HandlerFunc {
	return recorderCaptureSignalingHandler(service, func(w http.ResponseWriter, request *http.Request, identity workeridentity.Identity) (capturesignaling.Command, bool) {
		body, ok := decodeRecorderCaptureSignalingBody[recorderCaptureInspectBody](w, request)
		if !ok {
			return capturesignaling.Command{}, false
		}
		connection, err := captureplane.NewProviderReference(body.Connection)
		if err != nil {
			return capturesignaling.Command{}, false
		}
		tracks, tracksErr := recorderCapturePulledTracks(body.Tracks)
		if tracksErr != nil {
			return capturesignaling.Command{}, false
		}
		return recorderCaptureSignalingCommand(identity, body.recorderCaptureSignalingAuthorityBody, captureplane.OperationInspectCaptureConnection, capturesignaling.CommandInput{InspectCaptureConnection: &captureplane.InspectCaptureConnectionInput{Connection: connection, Tracks: tracks}})
	})
}

func recorderCaptureCloseTracksHandler(service RecorderCaptureSignalingService) http.HandlerFunc {
	return recorderCaptureSignalingHandler(service, func(w http.ResponseWriter, request *http.Request, identity workeridentity.Identity) (capturesignaling.Command, bool) {
		body, ok := decodeRecorderCaptureSignalingBody[recorderCaptureCloseTracksBody](w, request)
		if !ok {
			return capturesignaling.Command{}, false
		}
		connection, err := captureplane.NewProviderReference(body.Connection)
		tracks, tracksErr := recorderCapturePulledTracks(body.Tracks)
		if err != nil || tracksErr != nil {
			return capturesignaling.Command{}, false
		}
		return recorderCaptureSignalingCommand(identity, body.recorderCaptureSignalingAuthorityBody, captureplane.OperationCloseCaptureTracks, capturesignaling.CommandInput{CloseCaptureTracks: &captureplane.CloseCaptureTracksInput{Connection: connection, Tracks: tracks}})
	})
}

func recorderCaptureCloseConnectionHandler(service RecorderCaptureSignalingService) http.HandlerFunc {
	return recorderCaptureSignalingHandler(service, func(w http.ResponseWriter, request *http.Request, identity workeridentity.Identity) (capturesignaling.Command, bool) {
		body, ok := decodeRecorderCaptureSignalingBody[recorderCaptureCloseConnectionBody](w, request)
		if !ok {
			return capturesignaling.Command{}, false
		}
		connection, err := captureplane.NewProviderReference(body.Connection)
		if err != nil {
			return capturesignaling.Command{}, false
		}
		tracks, tracksErr := recorderCapturePulledTracks(body.Tracks)
		if tracksErr != nil {
			return capturesignaling.Command{}, false
		}
		return recorderCaptureSignalingCommand(identity, body.recorderCaptureSignalingAuthorityBody, captureplane.OperationCloseCaptureConnection, capturesignaling.CommandInput{CloseCaptureConnection: &captureplane.CloseCaptureConnectionInput{Connection: connection, Tracks: tracks, Force: body.Force}})
	})
}

func recorderCaptureSignalingHandler(
	service RecorderCaptureSignalingService,
	command func(http.ResponseWriter, *http.Request, workeridentity.Identity) (capturesignaling.Command, bool),
) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderWorkerRequestIdentity(w, request)
		if !ok {
			return
		}
		if identity.Role != workeridentity.RoleCapture {
			writeError(w, http.StatusForbidden, "worker.forbidden", "Only capture workers may exchange capture signaling")
			return
		}
		value, ok := command(w, request, identity)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid capture signaling command")
			return
		}
		execution, err := service.Execute(request.Context(), capturesignaling.ExecuteRequest{Command: value})
		if errors.Is(err, context.Canceled) {
			return
		}
		if err != nil {
			writeRecorderCaptureSignalingError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderCaptureSignalingResponse{Replayed: execution.Replayed, Result: execution.Result})
	}
}

func recorderCaptureSignalingCommand(
	identity workeridentity.Identity,
	body recorderCaptureSignalingAuthorityBody,
	operation captureplane.OperationKind,
	input capturesignaling.CommandInput,
) (capturesignaling.Command, bool) {
	handle, err := capturesignaling.NewSignalingHandle(body.SignalingHandle)
	tenantID, tenantErr := utilities.ParseID(body.TenantID)
	spaceID, spaceErr := utilities.ParseID(body.SpaceID)
	episodeID, episodeErr := utilities.ParseID(body.EpisodeID)
	recordingID, recordingErr := utilities.ParseID(body.RecordingID)
	jobID, jobErr := utilities.ParseID(body.JobID)
	digest, digestErr := decodeEnvelopeDigest(body.EnvelopeDigest)
	leaseExpiresAt, leaseErr := time.Parse(time.RFC3339Nano, body.LeaseExpiresAt)
	if err != nil || tenantErr != nil || spaceErr != nil || episodeErr != nil || recordingErr != nil || jobErr != nil || digestErr != nil || leaseErr != nil || body.CaptureEpoch < 1 || body.PlanRevision < 1 {
		return capturesignaling.Command{}, false
	}
	command := capturesignaling.Command{
		SignalingHandle: handle,
		Authority: capturesignaling.CommandAuthority{
			TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
			AttemptCount: body.AttemptCount, FencingGeneration: body.FencingGeneration,
			CaptureEpoch: captureplane.CaptureEpoch(body.CaptureEpoch), EnvelopeDigest: digest,
		},
		Lease: capturesignaling.WorkerLease{
			Owner: recorderWorkerLeaseOwner(identity), Token: body.LeaseToken, ExpiresAt: leaseExpiresAt.UTC(),
		},
		Identity: capturesignaling.CommandIdentity{
			Operation: operation, PlanRevision: captureplane.PlanRevision(body.PlanRevision), IdempotencyKey: body.IdempotencyKey,
		},
		Input: input,
	}
	_, _, canonicalErr := capturesignaling.CanonicalRequest(command)
	return command, canonicalErr == nil
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

var _ RecorderCaptureSignalingService = (*capturesignaling.Service)(nil)
