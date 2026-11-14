package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
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

const recorderRenderCommitBodyLimit = 64 << 20

func mountRecorderRenderAuthorityRoutes(r chi.Router, service RecorderRenderAuthorityService, logger *slog.Logger) {
	if service == nil {
		return
	}
	r.Post(string(recorderprotocol.RouteRenderInputsResolve), recorderResolveRenderInputHandler(service))
	r.Post(string(recorderprotocol.RouteRenderKeysAccess), recorderAccessRenderKeyHandler(service))
	r.Post(string(recorderprotocol.RouteRenderObjectsReserve), recorderReserveRenderObjectHandler(service))
	r.Post(string(recorderprotocol.RouteRenderObjectsFinalize), recorderFinalizeRenderObjectHandler(service))
	r.Post(string(recorderprotocol.RouteRenderObjectsCommit), recorderCommitRenderObjectHandler(service))
	r.Post(string(recorderprotocol.RouteRendersCommit), recorderCommitRenderHandler(service, logger))
	r.Post(string(recorderprotocol.RouteRendersTranscriptionDone), recorderCommitTranscriptionPreparationHandler(service))
}

func recorderResolveRenderInputHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RenderAuthority](w, request)
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
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RenderKeyAccessRequest](w, request)
		if !ok {
			return
		}
		authority, ok := recordingRenderAuthority(identity, body.RenderAuthority)
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
		writeJSON(w, http.StatusOK, recorderprotocol.RenderKeyResponse{KeyHandle: key.KeyHandle.String(), Plaintext: plaintext, CaptureEpoch: key.CaptureEpoch})
	}
}

func recorderReserveRenderObjectHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RenderObjectReserveRequest](w, request)
		if !ok {
			return
		}
		authority, valid := recordingRenderAuthority(identity, body.RenderAuthority)
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
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RenderObjectFinalizeRequest](w, request)
		if !ok {
			return
		}
		authority, valid := recordingRenderAuthority(identity, body.RenderAuthority)
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
		body, ok := decodeRecorderWorkerBody[recorderprotocol.RenderObjectCommitRequest](w, request)
		if !ok {
			return
		}
		authority, valid := recordingRenderAuthority(identity, body.RenderAuthority)
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
		body, ok := decodeRecorderWorkerBodyWithLimit[recorderprotocol.RenderCommitRequest](w, request, recorderRenderCommitBodyLimit)
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
		body, ok := decodeRecorderWorkerBody[recorderprotocol.TranscriptionCommitRequest](w, request)
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

func recorderRenderIdentity(w http.ResponseWriter, request *http.Request) (workeridentity.Identity, bool) {
	identity, ok := recorderWorkerRequestIdentity(w, request)
	if !ok {
		return workeridentity.Identity{}, false
	}
	if identity.Role != workeridentity.RoleRender {
		writeError(w, http.StatusForbidden, recorderprotocol.CodeWorkerForbidden, "Only render workers may access recording render authority")
		return workeridentity.Identity{}, false
	}
	return identity, true
}

func recordingRenderAuthority(identity workeridentity.Identity, body recorderprotocol.RenderAuthority) (recordingrender.Authority, bool) {
	base, ok := parseRecorderRecordingAuthority(identity, body.RecordingAuthority)
	tenantID, tenantErr := utilities.ParseID(base.tenantID)
	episodeID, episodeErr := utilities.ParseID(base.episodeID)
	recordingID, recordingErr := utilities.ParseID(base.recordingID)
	jobID, jobErr := utilities.ParseID(base.jobID)
	spaceID, spaceErr := utilities.ParseID(body.SpaceID)
	renderInputHandle, inputErr := utilities.ParseID(body.RenderInputHandle)
	keyHandle, keyErr := utilities.ParseID(body.KeyHandle)
	objectHandle, objectErr := utilities.ParseID(body.ObjectHandle)
	if !ok || tenantErr != nil || episodeErr != nil || recordingErr != nil || jobErr != nil || spaceErr != nil || inputErr != nil || keyErr != nil || objectErr != nil {
		return recordingrender.Authority{}, false
	}
	authority := recordingrender.Authority{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID,
		RecordingID: recordingID, JobID: jobID,
		RenderInputHandle: renderInputHandle, KeyHandle: keyHandle, ObjectHandle: objectHandle,
		AttemptCount: base.attemptCount, FencingGeneration: base.fencingGeneration, CaptureEpoch: base.captureEpoch,
		EnvelopeDigest: append([]byte(nil), base.envelopeDigest...), LeaseToken: base.leaseToken,
		LeaseOwner: base.leaseOwner, LeaseExpiresAt: base.leaseExpiresAt,
	}
	return authority, authority.Validate() == nil
}

func recordingRenderCommitInput(identity workeridentity.Identity, body recorderprotocol.RenderCommitRequest) (recordingrender.CommitInput, bool) {
	authority, ok := recordingRenderAuthority(identity, body.RenderAuthority)
	commitDigest, commitErr := decodeSHA256Hex(body.CommitDigest)
	presentationSHA256, presentationErr := decodeSHA256Hex(body.PresentationSHA256)
	ffprobeDigest, ffprobeErr := decodeSHA256Hex(body.FFprobeFactsDigest)
	video, videoOK := recordingRenderObjectReference(body.Video)
	if !ok || commitErr != nil || presentationErr != nil || ffprobeErr != nil || !videoOK {
		return recordingrender.CommitInput{}, false
	}
	input := recordingrender.CommitInput{VideoDegradation: body.VideoDegradation, Authority: authority, CommitDigest: commitDigest, PresentationSHA256: presentationSHA256, DurationMillis: body.DurationMillis, Video: video, FFprobeFactsDigest: ffprobeDigest}
	if body.TranscriptionSource != nil {
		source, valid := recordingRenderTranscriptionSource(*body.TranscriptionSource)
		if !valid {
			return recordingrender.CommitInput{}, false
		}
		input.TranscriptionSource = &source
	}
	return input, input.Validate() == nil
}

func recordingTranscriptionPreparationInput(identity workeridentity.Identity, body recorderprotocol.TranscriptionCommitRequest) (recordingrender.TranscriptionPreparationInput, bool) {
	authority, ok := recordingRenderAuthority(identity, body.RenderAuthority)
	commitDigest, commitErr := decodeSHA256Hex(body.CommitDigest)
	presentationSHA256, presentationErr := decodeSHA256Hex(body.PresentationSHA256)
	if !ok || commitErr != nil || presentationErr != nil {
		return recordingrender.TranscriptionPreparationInput{}, false
	}
	input := recordingrender.TranscriptionPreparationInput{Authority: authority, CommitDigest: commitDigest, PresentationSHA256: presentationSHA256, DurationMillis: body.DurationMillis}
	if body.TranscriptionSource != nil {
		source, valid := recordingRenderTranscriptionSource(*body.TranscriptionSource)
		if !valid {
			return recordingrender.TranscriptionPreparationInput{}, false
		}
		input.TranscriptionSource = &source
	}
	return input, input.Validate() == nil
}

func recordingRenderTranscriptionSource(body recorderprotocol.RenderTranscriptionSource) (recordingrender.TranscriptionSource, bool) {
	presentationSHA256, err := decodeSHA256Hex(body.PresentationSHA256)
	manifest, manifestOK := recordingRenderObjectReference(body.Manifest)
	if err != nil || !manifestOK {
		return recordingrender.TranscriptionSource{}, false
	}
	source := recordingrender.TranscriptionSource{SchemaVersion: body.SchemaVersion, PresentationSHA256: presentationSHA256, Manifest: manifest, Chunks: make([]recordingrender.TranscriptionChunk, 0, len(body.Chunks))}
	for _, bodyChunk := range body.Chunks {
		chunkID, chunkErr := utilities.ParseID(bodyChunk.ChunkID)
		object, objectOK := recordingRenderObjectReference(bodyChunk.Object)
		if chunkErr != nil || !objectOK {
			return recordingrender.TranscriptionSource{}, false
		}
		source.Chunks = append(source.Chunks, recordingrender.TranscriptionChunk{
			ChunkID: chunkID, Index: bodyChunk.Index, Generation: bodyChunk.Generation,
			StartMillis: bodyChunk.StartMillis, EndMillis: bodyChunk.EndMillis,
			SourceStartMillis: bodyChunk.SourceStartMillis, SourceEndMillis: bodyChunk.SourceEndMillis,
			ParticipantRef: bodyChunk.ParticipantRef, ParticipantGeneration: bodyChunk.ParticipantGeneration,
			DisplayNameSnapshot: bodyChunk.DisplayNameSnapshot,
			TrackID:             bodyChunk.TrackID, TrackEpoch: bodyChunk.TrackEpoch, IdentityKind: bodyChunk.IdentityKind,
			TrackClass: bodyChunk.TrackClass, Overlap: bodyChunk.Overlap, Object: object,
		})
	}
	return source, true
}

func recordingRenderObjectReference(body recorderprotocol.RenderObjectReference) (recordingrender.CommitObjectReference, bool) {
	allocationID, allocationErr := utilities.ParseID(body.AllocationID)
	checksum, checksumErr := decodeSHA256Hex(body.SHA256)
	if allocationErr != nil || checksumErr != nil {
		return recordingrender.CommitObjectReference{}, false
	}
	return recordingrender.CommitObjectReference{
		AllocationID: allocationID, Purpose: recordingrender.ObjectPurpose(body.Purpose),
		Object:         recordingrender.ObjectFacts{ObjectKey: strings.TrimSpace(body.ObjectKey), ObjectVersion: strings.TrimSpace(body.ObjectVersion), ObjectETag: strings.TrimSpace(body.ObjectETag), ContentType: strings.TrimSpace(body.ContentType), ByteSize: body.ByteSize, SHA256: checksum},
		DurationMillis: body.DurationMillis,
	}, true
}

func recorderRenderInputResponseValue(input recordingrender.ResolvedInput) recorderprotocol.RenderInputResponse {
	response := recorderprotocol.RenderInputResponse{
		SchemaVersion: input.SchemaVersion, TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(),
		TranscriptionMode: input.TranscriptionMode,
		EpisodeID:         input.EpisodeID.String(), RecordingID: input.RecordingID.String(), CaptureEpoch: input.CaptureEpoch,
		CaptureReadyAt: utilities.FormatTimestamp(input.CaptureReadyAt), DurationMillis: input.DurationMillis,
		Capture: make([]recorderprotocol.RenderCaptureObject, 0, len(input.Capture)),
		Presentation: recorderprotocol.RenderPresentation{
			Handle: input.PresentationHandle.String(), SchemaVersion: input.PresentationSchemaVersion,
			ProfileVersion: input.PresentationProfileVersion, DurationMillis: input.DurationMillis,
			SHA256: hex.EncodeToString(input.PresentationSHA256), Object: recorderRenderObjectFactsResponseValue(input.Presentation),
		},
		AssetManifest: recorderRenderObjectFactsResponseValue(input.AssetManifest), Assets: make([]recorderprotocol.RenderObject, 0, len(input.Assets)),
	}
	for _, captureObject := range input.Capture {
		response.Capture = append(response.Capture, recorderprotocol.RenderCaptureObject{
			RenderObject: recorderRenderObjectFactsResponseValue(recordingrender.DownloadableObject{ObjectFacts: captureObject.ObjectFacts, Download: captureObject.Download}),
			CaptureEpoch: captureObject.CaptureEpoch, CaptureJobID: captureObject.CaptureJobID.String(), KeyHandle: captureObject.KeyHandle.String(), EnvelopeDigest: hex.EncodeToString(captureObject.EnvelopeDigest), BundleSchema: captureObject.BundleSchema,
			SequenceNumber: captureObject.SequenceNumber, MonotonicStartMillis: captureObject.MonotonicStartMillis,
			MonotonicEndMillis: captureObject.MonotonicEndMillis, MediaStartMillis: captureObject.MediaStartMillis,
			MediaEndMillis: captureObject.MediaEndMillis, Codec: captureObject.Codec, Layer: captureObject.Layer,
		})
	}
	for _, asset := range input.Assets {
		response.Assets = append(response.Assets, recorderRenderObjectFactsResponseValue(asset))
	}
	return response
}

func recorderRenderObjectFactsResponseValue(value recordingrender.DownloadableObject) recorderprotocol.RenderObject {
	return recorderprotocol.RenderObject{
		ObjectKey: value.ObjectKey, ObjectVersion: value.ObjectVersion, ObjectETag: value.ObjectETag,
		ContentType: value.ContentType, ByteSize: value.ByteSize, SHA256: hex.EncodeToString(value.SHA256),
		Download: recorderprotocol.RenderDownload{Method: value.Download.Method, URL: value.Download.URL, ExpiresAt: utilities.FormatTimestamp(value.Download.ExpiresAt), SignedHeaders: value.Download.SignedHeaders},
	}
}

func recorderRenderObjectReserveResponseValue(value recordingrender.ReservedObject) recorderprotocol.RenderObjectReserveResponse {
	return recorderprotocol.RenderObjectReserveResponse{AllocationID: value.AllocationID.String(), ObjectKey: value.ObjectKey, Purpose: string(value.Purpose), AllocationVersion: value.AllocationVersion}
}

func recorderRenderObjectFinalizeResponseValue(value recordingrender.FinalizedObject) recorderprotocol.RenderObjectFinalizeResponse {
	return recorderprotocol.RenderObjectFinalizeResponse{
		RenderObjectReserveResponse: recorderRenderObjectReserveResponseValue(value.ReservedObject),
		UploadToken:                 value.UploadToken, ExpiresAt: utilities.FormatTimestamp(value.ExpiresAt),
		Upload: recorderprotocol.SignedUploadResponse{Method: value.Upload.Method, URL: value.Upload.URL, ExpiresAt: utilities.FormatTimestamp(value.Upload.ExpiresAt), SignedHeaders: cloneSignedHeaders(value.Upload)},
	}
}

func recorderRenderObjectCommitResponseValue(value recordingrender.CommittedObject) recorderprotocol.RenderObjectCommitResponse {
	return recorderprotocol.RenderObjectCommitResponse{
		RenderObjectReserveResponse: recorderRenderObjectReserveResponseValue(value.ReservedObject),
		ObjectVersion:               value.Object.ObjectVersion, ObjectETag: value.Object.ObjectETag,
		ContentType: value.Object.ContentType, ByteSize: value.Object.ByteSize, SHA256: hex.EncodeToString(value.Object.SHA256),
		DurationMillis: value.DurationMillis, CommittedAt: utilities.FormatTimestamp(value.CommittedAt),
	}
}

func recorderRenderCommitResponseValue(value recordingrender.CommitResult) recorderprotocol.RenderCommitResponse {
	response := recorderprotocol.RenderCommitResponse{Artifact: recorderWorkerArtifactResponseValue(value.Artifact), TranscriptionJobIDs: make([]string, 0)}
	if value.Transcription != nil {
		sourceID := value.Transcription.SourceID.String()
		response.TranscriptionSourceID = &sourceID
		response.TranscriptionJobIDs = make([]string, 0, len(value.Transcription.JobIDs))
		for _, jobID := range value.Transcription.JobIDs {
			response.TranscriptionJobIDs = append(response.TranscriptionJobIDs, jobID.String())
		}
	}
	return response
}

func recorderTranscriptionPreparationCommitResponseValue(value *recordingrender.TranscriptionResult) recorderprotocol.TranscriptionCommitResponse {
	response := recorderprotocol.TranscriptionCommitResponse{TranscriptionJobIDs: []string{}}
	if value == nil {
		return response
	}
	sourceID := value.SourceID.String()
	response.TranscriptionSourceID = &sourceID
	response.TranscriptionJobIDs = make([]string, 0, len(value.JobIDs))
	for _, jobID := range value.JobIDs {
		response.TranscriptionJobIDs = append(response.TranscriptionJobIDs, jobID.String())
	}
	return response
}

func writeRecorderRenderAuthorityError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, recordingrender.ErrInvalidRequest):
		writeError(w, http.StatusBadRequest, "request.invalid", "Invalid recording render request")
	case errors.Is(err, recordingrender.ErrAuthorityMismatch), errors.Is(err, recordingrender.ErrLeaseStale), errors.Is(err, recordingrender.ErrAllocationExpired):
		writeError(w, http.StatusConflict, "lease.stale", "Recording render authority is stale or unavailable")
	case errors.Is(err, recordingrender.ErrInputIncomplete):
		writeError(w, http.StatusConflict, "render.input_incomplete", "Recording render input is incomplete")
	case errors.Is(err, recordingrender.ErrInputTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "render.input_too_large", "Recording render input exceeds bounds")
	case errors.Is(err, recordingrender.ErrAllocationConflict), errors.Is(err, recordingrender.ErrCommitConflict):
		writeError(w, http.StatusConflict, "render.conflict", "Recording render request conflicts with committed authority")
	case errors.Is(err, recordingrender.ErrInputNotFound), errors.Is(err, recordingrender.ErrKeyNotFound), errors.Is(err, recordingrender.ErrAllocationNotFound):
		writeError(w, http.StatusNotFound, "render.not_found", "Recording render authority resource was not found")
	case errors.Is(err, recordingrender.ErrObjectFactsMismatch):
		writeError(w, http.StatusPreconditionFailed, "render.object_mismatch", "Uploaded render object does not match its allocation")
	case errors.Is(err, recordingrender.ErrRepositoryUnavailable), errors.Is(err, recordingrender.ErrStorageUnavailable), errors.Is(err, recordingrender.ErrKMSUnavailable), errors.Is(err, objectstorage.ErrStoreUnavailable):
		writeError(w, http.StatusServiceUnavailable, "service.unavailable", "Recording render authority is unavailable")
	case errors.Is(err, recordingrender.ErrTranscriptionUnavailable):
		writeError(w, http.StatusServiceUnavailable, "transcription.unavailable", "Recording transcription runtime is unavailable")
	case errors.Is(err, recordingkeys.ErrKMSFailed), errors.Is(err, objectstorage.ErrProviderFailed):
		writeError(w, http.StatusBadGateway, "provider.failed", "Recording render storage provider failed")
	default:
		writeError(w, http.StatusInternalServerError, "internal.error", "Recording render operation failed")
	}
}

var _ RecorderRenderAuthorityService = recordingrender.Service{}
