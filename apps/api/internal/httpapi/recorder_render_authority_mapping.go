package httpapi

import (
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingkeys"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func recorderRenderIdentity(w http.ResponseWriter, request *http.Request) (workeridentity.Identity, bool) {
	identity, ok := recorderWorkerRequestIdentity(w, request)
	if !ok {
		return workeridentity.Identity{}, false
	}
	if identity.Role != workeridentity.RoleRender {
		writeError(w, http.StatusForbidden, "worker.forbidden", "Only render workers may access recording render authority")
		return workeridentity.Identity{}, false
	}
	return identity, true
}

func recordingRenderAuthority(identity workeridentity.Identity, body recorderRenderAuthorityBody) (recordingrender.Authority, bool) {
	base, ok := parseRecorderRecordingAuthority(identity, body.recorderRecordingAuthorityBody)
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

func recordingRenderCommitInput(identity workeridentity.Identity, body recorderRenderCommitBody) (recordingrender.CommitInput, bool) {
	authority, ok := recordingRenderAuthority(identity, body.recorderRenderAuthorityBody)
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

func recordingTranscriptionPreparationInput(identity workeridentity.Identity, body recorderTranscriptionPreparationCommitBody) (recordingrender.TranscriptionPreparationInput, bool) {
	authority, ok := recordingRenderAuthority(identity, body.recorderRenderAuthorityBody)
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

func recordingRenderTranscriptionSource(body recorderRenderTranscriptionSourceBody) (recordingrender.TranscriptionSource, bool) {
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

func recordingRenderObjectReference(body recorderRenderObjectReferenceBody) (recordingrender.CommitObjectReference, bool) {
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

func recorderRenderInputResponseValue(input recordingrender.ResolvedInput) recorderRenderInputResponse {
	response := recorderRenderInputResponse{
		SchemaVersion: input.SchemaVersion, TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(),
		TranscriptionMode: string(input.TranscriptionMode),
		EpisodeID:         input.EpisodeID.String(), RecordingID: input.RecordingID.String(), CaptureEpoch: input.CaptureEpoch,
		CaptureReadyAt: utilities.FormatTimestamp(input.CaptureReadyAt), DurationMillis: input.DurationMillis,
		Capture: make([]recorderRenderCaptureObjectResponse, 0, len(input.Capture)),
		Presentation: recorderRenderPresentationResponse{
			Handle: input.PresentationHandle.String(), SchemaVersion: input.PresentationSchemaVersion,
			ProfileVersion: input.PresentationProfileVersion, DurationMillis: input.DurationMillis,
			SHA256: hex.EncodeToString(input.PresentationSHA256), Object: recorderRenderObjectFactsResponseValue(input.Presentation),
		},
		AssetManifest: recorderRenderObjectFactsResponseValue(input.AssetManifest), Assets: make([]recorderRenderObjectFactsResponse, 0, len(input.Assets)),
	}
	for _, captureObject := range input.Capture {
		response.Capture = append(response.Capture, recorderRenderCaptureObjectResponse{
			recorderRenderObjectFactsResponse: recorderRenderObjectFactsResponseValue(recordingrender.DownloadableObject{ObjectFacts: captureObject.ObjectFacts, Download: captureObject.Download}),
			CaptureEpoch:                      captureObject.CaptureEpoch, CaptureJobID: captureObject.CaptureJobID.String(), KeyHandle: captureObject.KeyHandle.String(), EnvelopeDigest: hex.EncodeToString(captureObject.EnvelopeDigest), BundleSchema: captureObject.BundleSchema,
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

func recorderRenderObjectFactsResponseValue(value recordingrender.DownloadableObject) recorderRenderObjectFactsResponse {
	return recorderRenderObjectFactsResponse{
		ObjectKey: value.ObjectKey, ObjectVersion: value.ObjectVersion, ObjectETag: value.ObjectETag,
		ContentType: value.ContentType, ByteSize: value.ByteSize, SHA256: hex.EncodeToString(value.SHA256),
		Download: recorderRenderDownloadResponse{Method: value.Download.Method, URL: value.Download.URL, ExpiresAt: utilities.FormatTimestamp(value.Download.ExpiresAt), SignedHeaders: value.Download.SignedHeaders},
	}
}

func recorderRenderObjectReserveResponseValue(value recordingrender.ReservedObject) recorderRenderObjectReserveResponse {
	return recorderRenderObjectReserveResponse{AllocationID: value.AllocationID.String(), ObjectKey: value.ObjectKey, Purpose: string(value.Purpose), AllocationVersion: value.AllocationVersion}
}

func recorderRenderObjectFinalizeResponseValue(value recordingrender.FinalizedObject) recorderRenderObjectFinalizeResponse {
	return recorderRenderObjectFinalizeResponse{
		recorderRenderObjectReserveResponse: recorderRenderObjectReserveResponseValue(value.ReservedObject),
		UploadToken:                         value.UploadToken, ExpiresAt: utilities.FormatTimestamp(value.ExpiresAt),
		Upload: recorderSignedUploadResponse{Method: value.Upload.Method, URL: value.Upload.URL, ExpiresAt: utilities.FormatTimestamp(value.Upload.ExpiresAt), SignedHeaders: cloneSignedHeaders(value.Upload)},
	}
}

func recorderRenderObjectCommitResponseValue(value recordingrender.CommittedObject) recorderRenderObjectCommitResponse {
	return recorderRenderObjectCommitResponse{
		recorderRenderObjectReserveResponse: recorderRenderObjectReserveResponseValue(value.ReservedObject),
		ObjectVersion:                       value.Object.ObjectVersion, ObjectETag: value.Object.ObjectETag,
		ContentType: value.Object.ContentType, ByteSize: value.Object.ByteSize, SHA256: hex.EncodeToString(value.Object.SHA256),
		DurationMillis: value.DurationMillis, CommittedAt: utilities.FormatTimestamp(value.CommittedAt),
	}
}

func recorderRenderCommitResponseValue(value recordingrender.CommitResult) recorderRenderCommitResponse {
	response := recorderRenderCommitResponse{Artifact: recorderWorkerArtifactResponseValue(value.Artifact), TranscriptionJobIDs: make([]string, 0)}
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

func recorderTranscriptionPreparationCommitResponseValue(value *recordingrender.TranscriptionResult) recorderTranscriptionPreparationCommitResponse {
	response := recorderTranscriptionPreparationCommitResponse{TranscriptionJobIDs: []string{}}
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
