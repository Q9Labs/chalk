package recorderworker

import (
	"bytes"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func renderAuthorityBody(authority recordingrender.Authority) recorderprotocol.RenderAuthority {
	return recorderprotocol.RenderAuthority{
		RecordingAuthority: recorderprotocol.RecordingAuthority{
			TenantID: authority.TenantID.String(), EpisodeID: authority.EpisodeID.String(), RecordingID: authority.RecordingID.String(), JobID: authority.JobID.String(),
			AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration, CaptureEpoch: int64(authority.CaptureEpoch),
			EnvelopeDigest: hex.EncodeToString(authority.EnvelopeDigest), LeaseToken: authority.LeaseToken, LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: authority.LeaseExpiresAt.UTC().Format(time.RFC3339Nano),
		},
		SpaceID: authority.SpaceID.String(), RenderInputHandle: authority.RenderInputHandle.String(), KeyHandle: authority.KeyHandle.String(), ObjectHandle: authority.ObjectHandle.String(),
	}
}

func renderObjectReferenceBody(reference recordingrender.CommitObjectReference) recorderprotocol.RenderObjectReference {
	return recorderprotocol.RenderObjectReference{
		AllocationID: reference.AllocationID.String(), Purpose: string(reference.Purpose),
		ObjectKey: reference.Object.ObjectKey, ObjectVersion: reference.Object.ObjectVersion, ObjectETag: reference.Object.ObjectETag,
		ContentType: reference.Object.ContentType, ByteSize: reference.Object.ByteSize, SHA256: hex.EncodeToString(reference.Object.SHA256),
		DurationMillis: reference.DurationMillis,
	}
}

func renderTranscriptionSourceBody(source *recordingrender.TranscriptionSource) *recorderprotocol.RenderTranscriptionSource {
	if source == nil {
		return nil
	}
	result := &recorderprotocol.RenderTranscriptionSource{
		SchemaVersion: source.SchemaVersion, PresentationSHA256: hex.EncodeToString(source.PresentationSHA256),
		Manifest: renderObjectReferenceBody(source.Manifest), Chunks: make([]recorderprotocol.RenderTranscriptionChunk, 0, len(source.Chunks)),
	}
	for _, chunk := range source.Chunks {
		result.Chunks = append(result.Chunks, recorderprotocol.RenderTranscriptionChunk{
			ChunkID: chunk.ChunkID.String(), Index: chunk.Index, Generation: chunk.Generation,
			StartMillis: chunk.StartMillis, EndMillis: chunk.EndMillis, SourceStartMillis: chunk.SourceStartMillis, SourceEndMillis: chunk.SourceEndMillis,
			ParticipantRef: chunk.ParticipantRef, ParticipantGeneration: chunk.ParticipantGeneration, DisplayNameSnapshot: chunk.DisplayNameSnapshot,
			TrackID: chunk.TrackID, TrackEpoch: chunk.TrackEpoch, IdentityKind: chunk.IdentityKind, TrackClass: chunk.TrackClass, Overlap: chunk.Overlap,
			Object: renderObjectReferenceBody(chunk.Object),
		})
	}
	return result
}

func applySignedObjectHeaders(request *http.Request, headers map[string][]string) error {
	for name, values := range headers {
		if strings.EqualFold(name, "Authorization") || strings.EqualFold(name, "Cookie") || strings.EqualFold(name, "Proxy-Authorization") || strings.EqualFold(name, "Host") || strings.EqualFold(name, "Content-Length") {
			return ErrInvalidControlPlaneRequest
		}
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	return nil
}

func decodeResolvedRenderInput(authority recordingrender.Authority, response recorderprotocol.RenderInputResponse) (recordingrender.ResolvedInput, error) {
	if response.TranscriptionMode.Validate() != nil {
		return recordingrender.ResolvedInput{}, ProtocolError{Err: errors.New("recording render transcription policy is missing or invalid")}
	}
	tenantID, e1 := utilities.ParseID(response.TenantID)
	spaceID, e2 := utilities.ParseID(response.SpaceID)
	episodeID, e3 := utilities.ParseID(response.EpisodeID)
	recordingID, e4 := utilities.ParseID(response.RecordingID)
	presentationHandle, e5 := utilities.ParseID(response.Presentation.Handle)
	captureReadyAt, e6 := parseRequiredTime(response.CaptureReadyAt)
	presentationSHA256, e7 := decodeExactLowerHex(response.Presentation.SHA256)
	if errors.Join(e1, e2, e3, e4, e5, e6, e7) != nil || response.SchemaVersion != recordingrender.InputSchemaVersion || tenantID != authority.TenantID || spaceID != authority.SpaceID || episodeID != authority.EpisodeID || recordingID != authority.RecordingID || response.CaptureEpoch != authority.CaptureEpoch || response.DurationMillis <= 0 || response.Presentation.DurationMillis != response.DurationMillis || response.Presentation.SchemaVersion != recordingrender.PresentationSchemaVersion || strings.TrimSpace(response.Presentation.ProfileVersion) == "" {
		return recordingrender.ResolvedInput{}, ProtocolError{Err: errors.New("recording render input authority mismatch")}
	}
	presentation, err := decodeDownloadableRenderObject(response.Presentation.Object)
	if err != nil {
		return recordingrender.ResolvedInput{}, err
	}
	if !bytes.Equal(presentation.SHA256, presentationSHA256) {
		return recordingrender.ResolvedInput{}, ProtocolError{Err: errors.New("recording presentation digest mismatch")}
	}
	assetManifest, err := decodeDownloadableRenderObject(response.AssetManifest)
	if err != nil {
		return recordingrender.ResolvedInput{}, err
	}
	result := recordingrender.ResolvedInput{SchemaVersion: response.SchemaVersion, TranscriptionMode: response.TranscriptionMode, TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: recordingID, CaptureEpoch: response.CaptureEpoch, CaptureReadyAt: captureReadyAt, DurationMillis: response.DurationMillis, Presentation: presentation, PresentationHandle: presentationHandle, PresentationSchemaVersion: response.Presentation.SchemaVersion, PresentationProfileVersion: response.Presentation.ProfileVersion, PresentationSHA256: presentationSHA256, AssetManifest: assetManifest, Capture: make([]recordingrender.DownloadableCaptureObject, 0, len(response.Capture)), Assets: make([]recordingrender.DownloadableObject, 0, len(response.Assets))}
	for _, capture := range response.Capture {
		object, err := decodeDownloadableRenderObject(capture.RenderObject)
		if err != nil {
			return recordingrender.ResolvedInput{}, err
		}
		captureJobID, jobErr := utilities.ParseID(capture.CaptureJobID)
		keyHandle, keyErr := utilities.ParseID(capture.KeyHandle)
		envelopeDigest, digestErr := decodeExactLowerHex(capture.EnvelopeDigest)
		if jobErr != nil || keyErr != nil || digestErr != nil || capture.CaptureEpoch <= 0 || capture.CaptureEpoch > response.CaptureEpoch {
			return recordingrender.ResolvedInput{}, ProtocolError{Err: errors.New("recording render capture authority mismatch")}
		}
		result.Capture = append(result.Capture, recordingrender.DownloadableCaptureObject{CaptureObject: recordingrender.CaptureObject{ObjectFacts: object.ObjectFacts, CaptureEpoch: capture.CaptureEpoch, CaptureJobID: captureJobID, KeyHandle: keyHandle, EnvelopeDigest: envelopeDigest, BundleSchema: capture.BundleSchema, SequenceNumber: capture.SequenceNumber, MonotonicStartMillis: capture.MonotonicStartMillis, MonotonicEndMillis: capture.MonotonicEndMillis, MediaStartMillis: capture.MediaStartMillis, MediaEndMillis: capture.MediaEndMillis, Codec: capture.Codec, Layer: capture.Layer}, Download: object.Download})
	}
	for _, asset := range response.Assets {
		object, err := decodeDownloadableRenderObject(asset)
		if err != nil {
			return recordingrender.ResolvedInput{}, err
		}
		result.Assets = append(result.Assets, object)
	}
	return result, nil
}

func decodeDownloadableRenderObject(response recorderprotocol.RenderObject) (recordingrender.DownloadableObject, error) {
	checksum, checksumErr := decodeExactLowerHex(response.SHA256)
	expiresAt, expiryErr := parseRequiredTime(response.Download.ExpiresAt)
	endpoint, urlErr := validateRecordingUploadURL(response.Download.URL)
	if errors.Join(checksumErr, expiryErr, urlErr, objectstorage.ValidateKey(response.ObjectKey)) != nil || response.Download.Method != http.MethodGet ||
		strings.TrimSpace(response.ObjectETag) == "" || strings.TrimSpace(response.ContentType) == "" || response.ByteSize <= 0 || !expiresAt.After(time.Now().UTC()) {
		return recordingrender.DownloadableObject{}, ProtocolError{Err: errors.New("recording render download response")}
	}
	return recordingrender.DownloadableObject{ObjectFacts: recordingrender.ObjectFacts{ObjectKey: response.ObjectKey, ObjectVersion: response.ObjectVersion, ObjectETag: response.ObjectETag, ContentType: response.ContentType, ByteSize: response.ByteSize, SHA256: checksum}, Download: recordingrender.DownloadGrant{Method: response.Download.Method, URL: endpoint.String(), ExpiresAt: expiresAt, SignedHeaders: cloneUploadHeaders(response.Download.SignedHeaders)}}, nil
}

func decodeFinalizedRenderObject(input recordingrender.FinalizeObjectInput, response recorderprotocol.RenderObjectFinalizeResponse) (recordingrender.FinalizedObject, error) {
	allocationID, idErr := utilities.ParseID(response.AllocationID)
	expiresAt, expiryErr := parseRequiredTime(response.ExpiresAt)
	uploadExpiresAt, uploadExpiryErr := parseRequiredTime(response.Upload.ExpiresAt)
	endpoint, urlErr := validateRecordingUploadURL(response.Upload.URL)
	if errors.Join(idErr, expiryErr, uploadExpiryErr, urlErr) != nil || allocationID != input.AllocationID || response.Purpose != string(input.Purpose) || response.AllocationVersion <= 0 || response.Upload.Method != http.MethodPut || strings.TrimSpace(response.UploadToken) == "" || !uploadExpiresAt.After(time.Now().UTC()) || !expiresAt.After(time.Now().UTC()) {
		return recordingrender.FinalizedObject{}, ProtocolError{Err: errors.New("recording render finalization response")}
	}
	// Allocation and storage grants have independent signing clocks. Uploads
	// must stop at whichever deadline arrives first.
	if uploadExpiresAt.After(expiresAt) {
		uploadExpiresAt = expiresAt
	}
	return recordingrender.FinalizedObject{ReservedObject: recordingrender.ReservedObject{AllocationID: allocationID, ObjectKey: response.ObjectKey, Purpose: input.Purpose, AllocationVersion: response.AllocationVersion}, UploadToken: response.UploadToken, Upload: objectstorage.SignedURL{Method: response.Upload.Method, URL: endpoint.String(), ExpiresAt: uploadExpiresAt, SignedHeader: cloneUploadHeaders(response.Upload.SignedHeaders)}, ExpiresAt: expiresAt}, nil
}

func decodeCommittedRenderObject(allocationID utilities.ID, response recorderprotocol.RenderObjectCommitResponse) (recordingrender.CommittedObject, error) {
	responseID, idErr := utilities.ParseID(response.AllocationID)
	checksum, checksumErr := decodeExactLowerHex(response.SHA256)
	committedAt, timeErr := parseRequiredTime(response.CommittedAt)
	if errors.Join(idErr, checksumErr, timeErr) != nil || responseID != allocationID || response.AllocationVersion <= 0 || response.ByteSize <= 0 || strings.TrimSpace(response.ObjectKey) == "" || strings.TrimSpace(response.ObjectETag) == "" {
		return recordingrender.CommittedObject{}, ProtocolError{Err: errors.New("recording render committed object response")}
	}
	return recordingrender.CommittedObject{ReservedObject: recordingrender.ReservedObject{AllocationID: responseID, ObjectKey: response.ObjectKey, Purpose: recordingrender.ObjectPurpose(response.Purpose), AllocationVersion: response.AllocationVersion}, Object: recordingrender.ObjectFacts{ObjectKey: response.ObjectKey, ObjectVersion: response.ObjectVersion, ObjectETag: response.ObjectETag, ContentType: response.ContentType, ByteSize: response.ByteSize, SHA256: checksum}, DurationMillis: response.DurationMillis, CommittedAt: committedAt}, nil
}

func decodeTranscriptionPreparationCommit(input recordingrender.TranscriptionPreparationInput, response recorderprotocol.TranscriptionCommitResponse) (*recordingrender.TranscriptionResult, error) {
	if input.TranscriptionSource == nil {
		if response.TranscriptionSourceID != nil || len(response.TranscriptionJobIDs) != 0 {
			return nil, ProtocolError{Err: errors.New("unexpected recording transcription preparation response")}
		}
		return nil, nil
	}
	if response.TranscriptionSourceID == nil {
		return nil, ProtocolError{Err: errors.New("missing recording transcription preparation response")}
	}
	sourceID, err := utilities.ParseID(*response.TranscriptionSourceID)
	if err != nil || sourceID != input.Authority.RecordingID {
		return nil, ProtocolError{Err: errors.New("invalid recording transcription preparation response")}
	}
	jobIDs := make([]utilities.ID, 0, len(response.TranscriptionJobIDs))
	for _, value := range response.TranscriptionJobIDs {
		jobID, parseErr := utilities.ParseID(value)
		if parseErr != nil || jobID.IsZero() {
			return nil, ProtocolError{Err: errors.New("invalid recording transcription preparation job response")}
		}
		jobIDs = append(jobIDs, jobID)
	}
	return &recordingrender.TranscriptionResult{SourceID: sourceID, JobIDs: jobIDs}, nil
}

func decodeRenderCommit(input recordingrender.CommitInput, response recorderprotocol.RenderCommitResponse) (recordingrender.CommitResult, error) {
	recordingID, recordingErr := utilities.ParseID(response.Artifact.RecordingID)
	tenantID, tenantErr := utilities.ParseID(response.Artifact.TenantID)
	jobID, jobErr := utilities.ParseID(response.Artifact.RenderJobID)
	checksum, checksumErr := decodeExactLowerHex(response.Artifact.Checksum)
	committedAt, committedErr := parseRequiredTime(response.Artifact.CommittedAt)
	createdAt, createdErr := parseRequiredTime(response.Artifact.CreatedAt)
	if errors.Join(recordingErr, tenantErr, jobErr, checksumErr, committedErr, createdErr) != nil ||
		recordingID != input.Authority.RecordingID || tenantID != input.Authority.TenantID || jobID != input.Authority.JobID ||
		response.Artifact.ObjectKey != input.Video.Object.ObjectKey || response.Artifact.ContentType != input.Video.Object.ContentType ||
		response.Artifact.ByteSize != input.Video.Object.ByteSize || !bytes.Equal(checksum, input.Video.Object.SHA256) || response.Artifact.DurationMillis != input.DurationMillis ||
		committedAt.Before(createdAt) {
		return recordingrender.CommitResult{}, ProtocolError{Err: errors.New("recording render commit response mismatch")}
	}
	result := recordingrender.CommitResult{Artifact: recordingpipeline.Artifact{
		RecordingID: recordingID, TenantID: tenantID, RenderJobID: jobID, ObjectKey: response.Artifact.ObjectKey,
		ContentType: response.Artifact.ContentType, ByteSize: response.Artifact.ByteSize, Checksum: checksum,
		Duration: time.Duration(response.Artifact.DurationMillis) * time.Millisecond, CommittedAt: committedAt, CreatedAt: createdAt,
	}}
	if input.TranscriptionSource == nil {
		if response.TranscriptionSourceID != nil || len(response.TranscriptionJobIDs) != 0 {
			return recordingrender.CommitResult{}, ProtocolError{Err: errors.New("unexpected recording transcription commit response")}
		}
		return result, nil
	}
	if response.TranscriptionSourceID == nil {
		return recordingrender.CommitResult{}, ProtocolError{Err: errors.New("missing recording transcription commit response")}
	}
	sourceID, err := utilities.ParseID(*response.TranscriptionSourceID)
	if err != nil || sourceID != input.Authority.RecordingID {
		return recordingrender.CommitResult{}, ProtocolError{Err: errors.New("invalid recording transcription commit response")}
	}
	jobIDs := make([]utilities.ID, 0, len(response.TranscriptionJobIDs))
	for _, value := range response.TranscriptionJobIDs {
		transcriptionJobID, parseErr := utilities.ParseID(value)
		if parseErr != nil || transcriptionJobID.IsZero() {
			return recordingrender.CommitResult{}, ProtocolError{Err: errors.New("invalid recording transcription job response")}
		}
		jobIDs = append(jobIDs, transcriptionJobID)
	}
	result.Transcription = &recordingrender.TranscriptionResult{SourceID: sourceID, JobIDs: jobIDs}
	return result, nil
}
