package httpapi

import (
	"context"
	"errors"
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

var _ RecorderCaptureSignalingService = (*capturesignaling.Service)(nil)
