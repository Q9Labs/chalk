package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
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
}

type recorderRenderAuthorityBody struct {
	recorderRecordingAuthorityBody
	SpaceID           string `json:"space_id"`
	RenderInputHandle string `json:"render_input_handle"`
	KeyHandle         string `json:"key_handle"`
	ObjectHandle      string `json:"object_handle"`
}

type recorderRenderObjectReserveBody struct {
	recorderRenderAuthorityBody
	Purpose              string `json:"purpose"`
	ReservationRequestID string `json:"reservation_request_id"`
}

type recorderRenderKeyAccessBody struct {
	recorderRenderAuthorityBody
	RequestedCaptureEpoch int64 `json:"requested_capture_epoch"`
}

type recorderRenderObjectFinalizeBody struct {
	recorderRenderAuthorityBody
	AllocationID   string `json:"allocation_id"`
	Purpose        string `json:"purpose"`
	ContentType    string `json:"content_type"`
	ByteSize       int64  `json:"byte_size"`
	SHA256         string `json:"sha256"`
	DurationMillis *int64 `json:"duration_ms"`
}

type recorderRenderObjectCommitBody struct {
	recorderRenderAuthorityBody
	AllocationID string `json:"allocation_id"`
	UploadToken  string `json:"upload_token"`
}

type recorderRenderObjectReferenceBody struct {
	AllocationID   string `json:"allocation_id"`
	Purpose        string `json:"purpose"`
	ObjectKey      string `json:"object_key"`
	ObjectVersion  string `json:"object_version"`
	ObjectETag     string `json:"object_etag"`
	ContentType    string `json:"content_type"`
	ByteSize       int64  `json:"byte_size"`
	SHA256         string `json:"sha256"`
	DurationMillis *int64 `json:"duration_ms"`
}

type recorderRenderTranscriptionChunkBody struct {
	ChunkID               string                            `json:"chunk_id"`
	Index                 int                               `json:"index"`
	Generation            int64                             `json:"generation"`
	StartMillis           int64                             `json:"start_ms"`
	EndMillis             int64                             `json:"end_ms"`
	SourceStartMillis     int64                             `json:"source_start_ms"`
	SourceEndMillis       int64                             `json:"source_end_ms"`
	ParticipantRef        string                            `json:"participant_ref"`
	ParticipantGeneration int64                             `json:"participant_generation"`
	DisplayNameSnapshot   string                            `json:"display_name_snapshot"`
	TrackID               string                            `json:"track_id"`
	TrackEpoch            string                            `json:"track_epoch"`
	IdentityKind          string                            `json:"identity_kind"`
	TrackClass            string                            `json:"track_class"`
	Overlap               bool                              `json:"overlap"`
	Object                recorderRenderObjectReferenceBody `json:"object"`
}

type recorderRenderTranscriptionSourceBody struct {
	SchemaVersion      string                                 `json:"schema_version"`
	PresentationSHA256 string                                 `json:"presentation_sha256"`
	Manifest           recorderRenderObjectReferenceBody      `json:"manifest"`
	Chunks             []recorderRenderTranscriptionChunkBody `json:"chunks"`
}

type recorderRenderCommitBody struct {
	recorderRenderAuthorityBody
	CommitDigest        string                                 `json:"commit_digest"`
	PresentationSHA256  string                                 `json:"presentation_sha256"`
	DurationMillis      int64                                  `json:"duration_ms"`
	Video               recorderRenderObjectReferenceBody      `json:"video"`
	FFprobeFactsDigest  string                                 `json:"ffprobe_facts_digest"`
	TranscriptionSource *recorderRenderTranscriptionSourceBody `json:"transcription_source"`
}

type recorderRenderDownloadResponse struct {
	Method        string              `json:"method"`
	URL           string              `json:"url"`
	ExpiresAt     string              `json:"expires_at"`
	SignedHeaders map[string][]string `json:"signed_headers"`
}

type recorderRenderObjectFactsResponse struct {
	ObjectKey     string                         `json:"object_key"`
	ObjectVersion string                         `json:"object_version"`
	ObjectETag    string                         `json:"object_etag"`
	ContentType   string                         `json:"content_type"`
	ByteSize      int64                          `json:"byte_size"`
	SHA256        string                         `json:"sha256"`
	Download      recorderRenderDownloadResponse `json:"download"`
}

type recorderRenderCaptureObjectResponse struct {
	recorderRenderObjectFactsResponse
	CaptureEpoch         int64   `json:"capture_epoch"`
	CaptureJobID         string  `json:"capture_job_id"`
	KeyHandle            string  `json:"key_handle"`
	EnvelopeDigest       string  `json:"envelope_digest"`
	SequenceNumber       int64   `json:"sequence"`
	MonotonicStartMillis int64   `json:"monotonic_start_ms"`
	MonotonicEndMillis   int64   `json:"monotonic_end_ms"`
	MediaStartMillis     int64   `json:"media_start_ms"`
	MediaEndMillis       int64   `json:"media_end_ms"`
	Codec                string  `json:"codec"`
	Layer                *string `json:"layer"`
}

type recorderRenderPresentationResponse struct {
	Handle         string                            `json:"handle"`
	SchemaVersion  string                            `json:"schema_version"`
	ProfileVersion string                            `json:"profile_version"`
	DurationMillis int64                             `json:"duration_ms"`
	SHA256         string                            `json:"sha256"`
	Object         recorderRenderObjectFactsResponse `json:"object"`
}

type recorderRenderInputResponse struct {
	SchemaVersion  string                                `json:"schema_version"`
	TenantID       string                                `json:"tenant_id"`
	SpaceID        string                                `json:"space_id"`
	EpisodeID      string                                `json:"episode_id"`
	RecordingID    string                                `json:"recording_id"`
	CaptureEpoch   int64                                 `json:"capture_epoch"`
	CaptureReadyAt string                                `json:"capture_ready_at"`
	DurationMillis int64                                 `json:"duration_ms"`
	Capture        []recorderRenderCaptureObjectResponse `json:"capture"`
	Presentation   recorderRenderPresentationResponse    `json:"presentation"`
	AssetManifest  recorderRenderObjectFactsResponse     `json:"asset_manifest"`
	Assets         []recorderRenderObjectFactsResponse   `json:"assets"`
}

type recorderRenderKeyResponse struct {
	KeyHandle    string `json:"key_handle"`
	Plaintext    string `json:"plaintext"`
	CaptureEpoch int64  `json:"capture_epoch"`
}

type recorderRenderObjectReserveResponse struct {
	AllocationID      string `json:"allocation_id"`
	ObjectKey         string `json:"object_key"`
	Purpose           string `json:"purpose"`
	AllocationVersion int64  `json:"allocation_version"`
}

type recorderRenderObjectFinalizeResponse struct {
	recorderRenderObjectReserveResponse
	UploadToken string                       `json:"upload_token"`
	Upload      recorderSignedUploadResponse `json:"upload"`
	ExpiresAt   string                       `json:"expires_at"`
}

type recorderRenderObjectCommitResponse struct {
	recorderRenderObjectReserveResponse
	ObjectVersion  string `json:"object_version"`
	ObjectETag     string `json:"object_etag"`
	ContentType    string `json:"content_type"`
	ByteSize       int64  `json:"byte_size"`
	SHA256         string `json:"sha256"`
	DurationMillis *int64 `json:"duration_ms"`
	CommittedAt    string `json:"committed_at"`
}

type recorderRenderCommitResponse struct {
	Artifact              recorderWorkerArtifactResponse `json:"artifact"`
	TranscriptionSourceID *string                        `json:"transcription_source_id"`
	TranscriptionJobIDs   []string                       `json:"transcription_job_ids"`
}

func mountRecorderRenderAuthorityRoutes(r chi.Router, service RecorderRenderAuthorityService) {
	if service == nil {
		return
	}
	r.Post("/render-inputs/resolve", recorderResolveRenderInputHandler(service))
	r.Post("/render-keys/access", recorderAccessRenderKeyHandler(service))
	r.Post("/render-objects/reserve", recorderReserveRenderObjectHandler(service))
	r.Post("/render-objects/finalize", recorderFinalizeRenderObjectHandler(service))
	r.Post("/render-objects/commit", recorderCommitRenderObjectHandler(service))
	r.Post("/renders/commit", recorderCommitRenderHandler(service))
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

func recorderCommitRenderHandler(service RecorderRenderAuthorityService) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		identity, ok := recorderRenderIdentity(w, request)
		if !ok {
			return
		}
		body, ok := decodeRecorderWorkerBody[recorderRenderCommitBody](w, request)
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
		writeJSON(w, http.StatusOK, recorderRenderCommitResponseValue(result))
	}
}

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
	input := recordingrender.CommitInput{Authority: authority, CommitDigest: commitDigest, PresentationSHA256: presentationSHA256, DurationMillis: body.DurationMillis, Video: video, FFprobeFactsDigest: ffprobeDigest}
	if body.TranscriptionSource != nil {
		source, valid := recordingRenderTranscriptionSource(*body.TranscriptionSource)
		if !valid {
			return recordingrender.CommitInput{}, false
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
		EpisodeID: input.EpisodeID.String(), RecordingID: input.RecordingID.String(), CaptureEpoch: input.CaptureEpoch,
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
			CaptureEpoch:                      captureObject.CaptureEpoch, CaptureJobID: captureObject.CaptureJobID.String(), KeyHandle: captureObject.KeyHandle.String(), EnvelopeDigest: hex.EncodeToString(captureObject.EnvelopeDigest),
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
