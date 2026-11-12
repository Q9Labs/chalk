package httpapi

import (
	"context"
	"encoding/base64"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RecorderRenderAuthorityService interface {
	ResolveRenderInput(context.Context, recordingrender.Authority) (recordingrender.ResolvedInput, error)
	AccessRenderKey(context.Context, recordingrender.AccessKeyInput) (recordingrender.DataKey, error)
	ReserveRenderObject(context.Context, recordingrender.ReserveObjectInput) (recordingrender.ReservedObject, error)
	FinalizeRenderObject(context.Context, recordingrender.FinalizeObjectInput) (recordingrender.FinalizedObject, error)
	CommitRenderObject(context.Context, recordingrender.CommitObjectInput) (recordingrender.CommittedObject, error)
	CommitRender(context.Context, recordingrender.CommitInput) (recordingrender.CommitResult, error)
	CommitTranscriptionPreparation(context.Context, recordingrender.TranscriptionPreparationInput) (*recordingrender.TranscriptionResult, error)
}

func mountRecorderRenderAuthorityRoutes(r chi.Router, service RecorderRenderAuthorityService, logger *slog.Logger) {
	if service == nil {
		return
	}
	r.Post("/render-inputs/resolve", recorderResolveRenderInputHandler(service))
	r.Post("/render-keys/access", recorderAccessRenderKeyHandler(service))
	r.Post("/render-objects/reserve", recorderReserveRenderObjectHandler(service))
	r.Post("/render-objects/finalize", recorderFinalizeRenderObjectHandler(service))
	r.Post("/render-objects/commit", recorderCommitRenderObjectHandler(service))
	r.Post("/renders/commit", recorderCommitRenderHandler(service, logger))
	r.Post("/renders/transcription-commit", recorderCommitTranscriptionPreparationHandler(service))
}

func recorderResolveRenderInputHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderRenderAuthorityBody](w, request)
		if !ok {
			return
		}
		authority, ok := recordingRenderAuthority(identity, body)
		if !ok {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording render authority")
			return
		}
		input, err := service.ResolveRenderInput(request.Context(), authority)
		if err != nil {
			writeRecorderRenderAuthorityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderRenderInputResponseValue(input))
	}
}

func recorderAccessRenderKeyHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderRenderKeyAccessBody](w, request)
		if !ok {
			return
		}
		authority, ok := recordingRenderAuthority(identity, body.recorderRenderAuthorityBody)
		input := recordingrender.AccessKeyInput{Authority: authority, CaptureEpoch: body.RequestedCaptureEpoch}
		if !ok || input.Validate() != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording render key authority")
			return
		}
		key, err := service.AccessRenderKey(request.Context(), input)
		if err != nil {
			writeRecorderRenderAuthorityError(w, err)
			return
		}
		plaintext := base64.StdEncoding.EncodeToString(key.Plaintext)
		recordingkeys.ClearPlaintext(key.Plaintext)
		writeJSON(w, http.StatusOK, recorderRenderKeyResponse{KeyHandle: key.KeyHandle.String(), Plaintext: plaintext, CaptureEpoch: key.CaptureEpoch})
	}
}

func recorderReserveRenderObjectHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderRenderObjectReserveBody](w, request)
		if !ok {
			return
		}
		authority, valid := recordingRenderAuthority(identity, body.recorderRenderAuthorityBody)
		requestID, requestErr := utilities.ParseID(body.ReservationRequestID)
		input := recordingrender.ReserveObjectInput{Authority: authority, Purpose: recordingrender.ObjectPurpose(body.Purpose), ReservationRequestID: requestID}
		if !valid || requestErr != nil || input.Validate() != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording render object reservation")
			return
		}
		reserved, err := service.ReserveRenderObject(request.Context(), input)
		if err != nil {
			writeRecorderRenderAuthorityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderRenderObjectReserveResponseValue(reserved))
	}
}

func recorderFinalizeRenderObjectHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderRenderObjectFinalizeBody](w, request)
		if !ok {
			return
		}
		authority, valid := recordingRenderAuthority(identity, body.recorderRenderAuthorityBody)
		allocationID, allocationErr := utilities.ParseID(body.AllocationID)
		checksum, checksumErr := decodeSHA256Hex(body.SHA256)
		input := recordingrender.FinalizeObjectInput{Authority: authority, AllocationID: allocationID, Purpose: recordingrender.ObjectPurpose(body.Purpose), ContentType: strings.TrimSpace(body.ContentType), ByteSize: body.ByteSize, SHA256: checksum, DurationMillis: body.DurationMillis}
		if !valid || allocationErr != nil || checksumErr != nil || input.Validate() != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording render object finalization")
			return
		}
		finalized, err := service.FinalizeRenderObject(request.Context(), input)
		if err != nil {
			writeRecorderRenderAuthorityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderRenderObjectFinalizeResponseValue(finalized))
	}
}

func recorderCommitRenderObjectHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderRenderObjectCommitBody](w, request)
		if !ok {
			return
		}
		authority, valid := recordingRenderAuthority(identity, body.recorderRenderAuthorityBody)
		allocationID, allocationErr := utilities.ParseID(body.AllocationID)
		input := recordingrender.CommitObjectInput{Authority: authority, AllocationID: allocationID, UploadToken: body.UploadToken}
		if !valid || allocationErr != nil || input.Validate() != nil {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording render object commit")
			return
		}
		committed, err := service.CommitRenderObject(request.Context(), input)
		if err != nil {
			writeRecorderRenderAuthorityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderRenderObjectCommitResponseValue(committed))
	}
}

func recorderCommitRenderHandler(service RecorderRenderAuthorityService, logger *slog.Logger) http.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		// A bounded timeline can introduce 100,000 canonical source IDs over
		// its history. Their per-source quality results exceed the ordinary
		// 1 MiB API body cap; only this authenticated worker commit gets 64 MiB.
		body, ok := decodeRecorderWorkerBodyWithLimit[recorderRenderCommitBody](w, request, recorderRenderCommitBodyLimit)
		if !ok {
			return
		}
		input, valid := recordingRenderCommitInput(identity, body)
		if !valid {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording render commit")
			return
		}
		result, err := service.CommitRender(request.Context(), input)
		if err != nil {
			writeRecorderRenderAuthorityError(w, err)
			return
		}
		logExportDegradation(logger, input.Authority.JobID.String(), input.VideoDegradation)
		writeJSON(w, http.StatusOK, recorderRenderCommitResponseValue(result))
	}
}

func recorderCommitTranscriptionPreparationHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderTranscriptionPreparationCommitBody](w, request)
		if !ok {
			return
		}
		input, valid := recordingTranscriptionPreparationInput(identity, body)
		if !valid {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording transcription preparation commit")
			return
		}
		result, err := service.CommitTranscriptionPreparation(request.Context(), input)
		if err != nil {
			writeRecorderRenderAuthorityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, recorderTranscriptionPreparationCommitResponseValue(result))
	}
}

var _ RecorderRenderAuthorityService = recordingrender.Service{}
