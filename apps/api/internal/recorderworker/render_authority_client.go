package recorderworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type renderAuthorityRequest struct {
	TenantID          string `json:"tenant_id"`
	SpaceID           string `json:"space_id"`
	EpisodeID         string `json:"episode_id"`
	RecordingID       string `json:"recording_id"`
	JobID             string `json:"job_id"`
	RenderInputHandle string `json:"render_input_handle"`
	KeyHandle         string `json:"key_handle"`
	ObjectHandle      string `json:"object_handle"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
	LeaseToken        string `json:"lease_token"`
	LeaseOwner        string `json:"lease_owner"`
	LeaseExpiresAt    string `json:"lease_expires_at"`
}

type renderKeyAccessRequest struct {
	renderAuthorityRequest
	RequestedCaptureEpoch int64 `json:"requested_capture_epoch"`
}

type renderDownloadResponse struct {
	Method        string              `json:"method"`
	URL           string              `json:"url"`
	ExpiresAt     string              `json:"expires_at"`
	SignedHeaders map[string][]string `json:"signed_headers"`
}

type renderObjectResponse struct {
	ObjectKey     string                 `json:"object_key"`
	ObjectVersion string                 `json:"object_version"`
	ObjectETag    string                 `json:"object_etag"`
	ContentType   string                 `json:"content_type"`
	ByteSize      int64                  `json:"byte_size"`
	SHA256        string                 `json:"sha256"`
	Download      renderDownloadResponse `json:"download"`
}

type renderCaptureResponse struct {
	renderObjectResponse
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

type renderInputResponse struct {
	SchemaVersion     string                           `json:"schema_version"`
	TranscriptionMode artifactpolicy.TranscriptionMode `json:"transcription_mode"`
	TenantID          string                           `json:"tenant_id"`
	SpaceID           string                           `json:"space_id"`
	EpisodeID         string                           `json:"episode_id"`
	RecordingID       string                           `json:"recording_id"`
	CaptureEpoch      int64                            `json:"capture_epoch"`
	CaptureReadyAt    string                           `json:"capture_ready_at"`
	DurationMillis    int64                            `json:"duration_ms"`
	Capture           []renderCaptureResponse          `json:"capture"`
	Presentation      struct {
		Handle         string               `json:"handle"`
		SchemaVersion  string               `json:"schema_version"`
		ProfileVersion string               `json:"profile_version"`
		DurationMillis int64                `json:"duration_ms"`
		SHA256         string               `json:"sha256"`
		Object         renderObjectResponse `json:"object"`
	} `json:"presentation"`
	AssetManifest renderObjectResponse   `json:"asset_manifest"`
	Assets        []renderObjectResponse `json:"assets"`
}

type renderReserveResponse struct {
	AllocationID      string `json:"allocation_id"`
	ObjectKey         string `json:"object_key"`
	Purpose           string `json:"purpose"`
	AllocationVersion int64  `json:"allocation_version"`
}

type renderFinalizeResponse struct {
	renderReserveResponse
	UploadToken string `json:"upload_token"`
	Upload      struct {
		Method        string              `json:"method"`
		URL           string              `json:"url"`
		ExpiresAt     string              `json:"expires_at"`
		SignedHeaders map[string][]string `json:"signed_headers"`
	} `json:"upload"`
	ExpiresAt string `json:"expires_at"`
}

type renderCommitObjectResponse struct {
	renderReserveResponse
	ObjectVersion  string `json:"object_version"`
	ObjectETag     string `json:"object_etag"`
	ContentType    string `json:"content_type"`
	ByteSize       int64  `json:"byte_size"`
	SHA256         string `json:"sha256"`
	DurationMillis *int64 `json:"duration_ms"`
	CommittedAt    string `json:"committed_at"`
}

type renderObjectReferenceRequest struct {
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

type renderTranscriptionChunkRequest struct {
	ChunkID               string                       `json:"chunk_id"`
	Index                 int                          `json:"index"`
	Generation            int64                        `json:"generation"`
	StartMillis           int64                        `json:"start_ms"`
	EndMillis             int64                        `json:"end_ms"`
	SourceStartMillis     int64                        `json:"source_start_ms"`
	SourceEndMillis       int64                        `json:"source_end_ms"`
	ParticipantRef        string                       `json:"participant_ref"`
	ParticipantGeneration int64                        `json:"participant_generation"`
	DisplayNameSnapshot   string                       `json:"display_name_snapshot"`
	TrackID               string                       `json:"track_id"`
	TrackEpoch            string                       `json:"track_epoch"`
	IdentityKind          string                       `json:"identity_kind"`
	TrackClass            string                       `json:"track_class"`
	Overlap               bool                         `json:"overlap"`
	Object                renderObjectReferenceRequest `json:"object"`
}

type renderTranscriptionSourceRequest struct {
	SchemaVersion      string                            `json:"schema_version"`
	PresentationSHA256 string                            `json:"presentation_sha256"`
	Manifest           renderObjectReferenceRequest      `json:"manifest"`
	Chunks             []renderTranscriptionChunkRequest `json:"chunks"`
}

type renderCommitRequest struct {
	renderAuthorityRequest
	CommitDigest        string                            `json:"commit_digest"`
	PresentationSHA256  string                            `json:"presentation_sha256"`
	DurationMillis      int64                             `json:"duration_ms"`
	Video               renderObjectReferenceRequest      `json:"video"`
	FFprobeFactsDigest  string                            `json:"ffprobe_facts_digest"`
	TranscriptionSource *renderTranscriptionSourceRequest `json:"transcription_source"`
}

type renderCommitResponse struct {
	Artifact struct {
		RecordingID    string `json:"recording_id"`
		TenantID       string `json:"tenant_id"`
		RenderJobID    string `json:"render_job_id"`
		ObjectKey      string `json:"object_key"`
		ContentType    string `json:"content_type"`
		ByteSize       int64  `json:"byte_size"`
		Checksum       string `json:"checksum"`
		DurationMillis int64  `json:"duration_millis"`
		CommittedAt    string `json:"committed_at"`
		CreatedAt      string `json:"created_at"`
	} `json:"artifact"`
	TranscriptionSourceID *string  `json:"transcription_source_id"`
	TranscriptionJobIDs   []string `json:"transcription_job_ids"`
}

type renderTranscriptionCommitRequest struct {
	renderAuthorityRequest
	CommitDigest        string                            `json:"commit_digest"`
	PresentationSHA256  string                            `json:"presentation_sha256"`
	DurationMillis      int64                             `json:"duration_ms"`
	TranscriptionSource *renderTranscriptionSourceRequest `json:"transcription_source,omitempty"`
}

type renderTranscriptionCommitResponse struct {
	TranscriptionSourceID *string  `json:"transcription_source_id"`
	TranscriptionJobIDs   []string `json:"transcription_job_ids"`
}

func (c *ControlPlaneClient) ResolveRenderInput(ctx context.Context, authority recordingrender.Authority) (recordingrender.ResolvedInput, error) {
	if err := authority.Validate(); err != nil {
		return recordingrender.ResolvedInput{}, ErrInvalidControlPlaneRequest
	}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/render-inputs/resolve", renderAuthorityBody(authority), ControlPlaneResponseLimit)
	if err != nil {
		return recordingrender.ResolvedInput{}, err
	}
	var response renderInputResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.ResolvedInput{}, ProtocolError{Err: err}
	}
	return decodeResolvedRenderInput(authority, response)
}

func (c *ControlPlaneClient) AccessRenderKey(ctx context.Context, input recordingrender.AccessKeyInput) (recordingrender.DataKey, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.DataKey{}, ErrInvalidControlPlaneRequest
	}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/render-keys/access", renderKeyAccessRequest{renderAuthorityRequest: renderAuthorityBody(input.Authority), RequestedCaptureEpoch: input.CaptureEpoch}, ControlPlaneResponseLimit)
	if err != nil {
		return recordingrender.DataKey{}, err
	}
	var response struct {
		KeyHandle    string `json:"key_handle"`
		Plaintext    string `json:"plaintext"`
		CaptureEpoch int64  `json:"capture_epoch"`
	}
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.DataKey{}, ProtocolError{Err: err}
	}
	keyID, idErr := utilities.ParseID(response.KeyHandle)
	plaintext, keyErr := base64.StdEncoding.DecodeString(response.Plaintext)
	if idErr != nil || keyErr != nil || keyID.IsZero() || response.CaptureEpoch != input.CaptureEpoch || len(plaintext) != 32 {
		clear(plaintext)
		return recordingrender.DataKey{}, ProtocolError{Err: errors.New("recording render key response authority mismatch")}
	}
	return recordingrender.DataKey{KeyHandle: keyID, Plaintext: plaintext, CaptureEpoch: response.CaptureEpoch}, nil
}

func (c *ControlPlaneClient) ReserveRenderObject(ctx context.Context, input recordingrender.ReserveObjectInput) (recordingrender.ReservedObject, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.ReservedObject{}, ErrInvalidControlPlaneRequest
	}
	payload := struct {
		renderAuthorityRequest
		Purpose              string `json:"purpose"`
		ReservationRequestID string `json:"reservation_request_id"`
	}{renderAuthorityRequest: renderAuthorityBody(input.Authority), Purpose: string(input.Purpose), ReservationRequestID: input.ReservationRequestID.String()}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/render-objects/reserve", payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingrender.ReservedObject{}, err
	}
	var response renderReserveResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.ReservedObject{}, ProtocolError{Err: err}
	}
	allocationID, parseErr := utilities.ParseID(response.AllocationID)
	if parseErr != nil || response.Purpose != string(input.Purpose) || response.AllocationVersion <= 0 || strings.TrimSpace(response.ObjectKey) == "" {
		return recordingrender.ReservedObject{}, ProtocolError{Err: errors.New("recording render reservation response")}
	}
	return recordingrender.ReservedObject{AllocationID: allocationID, ObjectKey: response.ObjectKey, Purpose: input.Purpose, AllocationVersion: response.AllocationVersion}, nil
}

func (c *ControlPlaneClient) FinalizeRenderObject(ctx context.Context, input recordingrender.FinalizeObjectInput) (recordingrender.FinalizedObject, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.FinalizedObject{}, ErrInvalidControlPlaneRequest
	}
	payload := struct {
		renderAuthorityRequest
		AllocationID   string `json:"allocation_id"`
		Purpose        string `json:"purpose"`
		ContentType    string `json:"content_type"`
		ByteSize       int64  `json:"byte_size"`
		SHA256         string `json:"sha256"`
		DurationMillis *int64 `json:"duration_ms"`
	}{renderAuthorityRequest: renderAuthorityBody(input.Authority), AllocationID: input.AllocationID.String(), Purpose: string(input.Purpose), ContentType: input.ContentType, ByteSize: input.ByteSize, SHA256: hex.EncodeToString(input.SHA256), DurationMillis: input.DurationMillis}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/render-objects/finalize", payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingrender.FinalizedObject{}, err
	}
	var response renderFinalizeResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.FinalizedObject{}, ProtocolError{Err: err}
	}
	return decodeFinalizedRenderObject(input, response)
}

func (c *ControlPlaneClient) CommitRenderObject(ctx context.Context, input recordingrender.CommitObjectInput) (recordingrender.CommittedObject, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.CommittedObject{}, ErrInvalidControlPlaneRequest
	}
	payload := struct {
		renderAuthorityRequest
		AllocationID string `json:"allocation_id"`
		UploadToken  string `json:"upload_token"`
	}{renderAuthorityRequest: renderAuthorityBody(input.Authority), AllocationID: input.AllocationID.String(), UploadToken: input.UploadToken}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/render-objects/commit", payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingrender.CommittedObject{}, err
	}
	var response renderCommitObjectResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.CommittedObject{}, ProtocolError{Err: err}
	}
	return decodeCommittedRenderObject(input.AllocationID, response)
}

func (c *ControlPlaneClient) CommitRender(ctx context.Context, input recordingrender.CommitInput) (recordingrender.CommitResult, error) {
	if err := input.Validate(); err != nil {
		return recordingrender.CommitResult{}, ErrInvalidControlPlaneRequest
	}
	payload := renderCommitRequest{
		renderAuthorityRequest: renderAuthorityBody(input.Authority),
		CommitDigest:           hex.EncodeToString(input.CommitDigest),
		PresentationSHA256:     hex.EncodeToString(input.PresentationSHA256),
		DurationMillis:         input.DurationMillis,
		Video:                  renderObjectReferenceBody(input.Video),
		FFprobeFactsDigest:     hex.EncodeToString(input.FFprobeFactsDigest),
	}
	payload.TranscriptionSource = renderTranscriptionSourceBody(input.TranscriptionSource)
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/renders/commit", payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingrender.CommitResult{}, err
	}
	var response renderCommitResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingrender.CommitResult{}, ProtocolError{Err: err}
	}
	return decodeRenderCommit(input, response)
}

func (c *ControlPlaneClient) CommitTranscriptionPreparation(ctx context.Context, input recordingrender.TranscriptionPreparationInput) (*recordingrender.TranscriptionResult, error) {
	if err := input.Validate(); err != nil {
		return nil, ErrInvalidControlPlaneRequest
	}
	payload := renderTranscriptionCommitRequest{
		renderAuthorityRequest: renderAuthorityBody(input.Authority),
		CommitDigest:           hex.EncodeToString(input.CommitDigest),
		PresentationSHA256:     hex.EncodeToString(input.PresentationSHA256),
		DurationMillis:         input.DurationMillis,
		TranscriptionSource:    renderTranscriptionSourceBody(input.TranscriptionSource),
	}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/renders/transcription-commit", payload, ControlPlaneResponseLimit)
	if err != nil {
		return nil, err
	}
	var response renderTranscriptionCommitResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return nil, ProtocolError{Err: err}
	}
	return decodeTranscriptionPreparationCommit(input, response)
}

func (c *ControlPlaneClient) UploadRenderObject(ctx context.Context, signed objectstorage.SignedURL, reader io.Reader, byteSize int64) error {
	if c == nil || c.uploader == nil || reader == nil || signed.Method != http.MethodPut || byteSize <= 0 || !signed.ExpiresAt.After(time.Now().UTC()) {
		return ErrInvalidControlPlaneRequest
	}
	endpoint, err := validateRecordingUploadURL(signed.URL)
	if err != nil {
		return ErrInvalidControlPlaneRequest
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), io.LimitReader(reader, byteSize+1))
	if err != nil {
		return ProtocolError{Err: err}
	}
	request.ContentLength = byteSize
	if err := applySignedObjectHeaders(request, signed.SignedHeader); err != nil {
		return err
	}
	response, err := c.uploader.Do(request)
	if err != nil {
		return TransportError{Err: errors.Join(ErrRecordingObjectUpload, err)}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("%w: %w", ErrRecordingObjectUpload, classifyHTTPError(response.StatusCode))
	}
	return nil
}

func (c *ControlPlaneClient) DownloadRenderObject(ctx context.Context, object recordingrender.DownloadableObject, outputPath string) error {
	if c == nil || c.uploader == nil || object.Download.Method != http.MethodGet || object.ByteSize <= 0 || len(object.SHA256) != sha256.Size || !object.Download.ExpiresAt.After(time.Now().UTC()) || strings.TrimSpace(outputPath) == "" {
		return ErrInvalidControlPlaneRequest
	}
	endpoint, err := validateRecordingUploadURL(object.Download.URL)
	if err != nil {
		return ErrInvalidControlPlaneRequest
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return ProtocolError{Err: err}
	}
	if err := applySignedObjectHeaders(request, object.Download.SignedHeaders); err != nil {
		return err
	}
	response, err := c.uploader.Do(request)
	if err != nil {
		return TransportError{Err: err}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return classifyHTTPError(response.StatusCode)
	}
	file, err := os.OpenFile(outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		_ = file.Close()
		if remove {
			_ = os.Remove(outputPath)
		}
	}()
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, object.ByteSize+1))
	if copyErr != nil || written != object.ByteSize || !bytes.Equal(hash.Sum(nil), object.SHA256) {
		return errors.New("downloaded recording render object facts do not match authority")
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	remove = false
	return nil
}

func renderAuthorityBody(authority recordingrender.Authority) renderAuthorityRequest {
	return renderAuthorityRequest{
		TenantID: authority.TenantID.String(), SpaceID: authority.SpaceID.String(), EpisodeID: authority.EpisodeID.String(), RecordingID: authority.RecordingID.String(), JobID: authority.JobID.String(),
		RenderInputHandle: authority.RenderInputHandle.String(), KeyHandle: authority.KeyHandle.String(), ObjectHandle: authority.ObjectHandle.String(),
		AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration, CaptureEpoch: authority.CaptureEpoch,
		EnvelopeDigest: hex.EncodeToString(authority.EnvelopeDigest), LeaseToken: authority.LeaseToken, LeaseOwner: authority.LeaseOwner, LeaseExpiresAt: authority.LeaseExpiresAt.UTC().Format(time.RFC3339Nano),
	}
}

func renderObjectReferenceBody(reference recordingrender.CommitObjectReference) renderObjectReferenceRequest {
	return renderObjectReferenceRequest{
		AllocationID: reference.AllocationID.String(), Purpose: string(reference.Purpose),
		ObjectKey: reference.Object.ObjectKey, ObjectVersion: reference.Object.ObjectVersion, ObjectETag: reference.Object.ObjectETag,
		ContentType: reference.Object.ContentType, ByteSize: reference.Object.ByteSize, SHA256: hex.EncodeToString(reference.Object.SHA256),
		DurationMillis: reference.DurationMillis,
	}
}

func renderTranscriptionSourceBody(source *recordingrender.TranscriptionSource) *renderTranscriptionSourceRequest {
	if source == nil {
		return nil
	}
	result := &renderTranscriptionSourceRequest{
		SchemaVersion: source.SchemaVersion, PresentationSHA256: hex.EncodeToString(source.PresentationSHA256),
		Manifest: renderObjectReferenceBody(source.Manifest), Chunks: make([]renderTranscriptionChunkRequest, 0, len(source.Chunks)),
	}
	for _, chunk := range source.Chunks {
		result.Chunks = append(result.Chunks, renderTranscriptionChunkRequest{
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

func decodeResolvedRenderInput(authority recordingrender.Authority, response renderInputResponse) (recordingrender.ResolvedInput, error) {
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
		object, err := decodeDownloadableRenderObject(capture.renderObjectResponse)
		if err != nil {
			return recordingrender.ResolvedInput{}, err
		}
		captureJobID, jobErr := utilities.ParseID(capture.CaptureJobID)
		keyHandle, keyErr := utilities.ParseID(capture.KeyHandle)
		envelopeDigest, digestErr := decodeExactLowerHex(capture.EnvelopeDigest)
		if jobErr != nil || keyErr != nil || digestErr != nil || capture.CaptureEpoch <= 0 || capture.CaptureEpoch > response.CaptureEpoch {
			return recordingrender.ResolvedInput{}, ProtocolError{Err: errors.New("recording render capture authority mismatch")}
		}
		result.Capture = append(result.Capture, recordingrender.DownloadableCaptureObject{CaptureObject: recordingrender.CaptureObject{ObjectFacts: object.ObjectFacts, CaptureEpoch: capture.CaptureEpoch, CaptureJobID: captureJobID, KeyHandle: keyHandle, EnvelopeDigest: envelopeDigest, SequenceNumber: capture.SequenceNumber, MonotonicStartMillis: capture.MonotonicStartMillis, MonotonicEndMillis: capture.MonotonicEndMillis, MediaStartMillis: capture.MediaStartMillis, MediaEndMillis: capture.MediaEndMillis, Codec: capture.Codec, Layer: capture.Layer}, Download: object.Download})
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

func decodeDownloadableRenderObject(response renderObjectResponse) (recordingrender.DownloadableObject, error) {
	checksum, checksumErr := decodeExactLowerHex(response.SHA256)
	expiresAt, expiryErr := parseRequiredTime(response.Download.ExpiresAt)
	endpoint, urlErr := validateRecordingUploadURL(response.Download.URL)
	if errors.Join(checksumErr, expiryErr, urlErr, objectstorage.ValidateKey(response.ObjectKey)) != nil || response.Download.Method != http.MethodGet ||
		strings.TrimSpace(response.ObjectETag) == "" || strings.TrimSpace(response.ContentType) == "" || response.ByteSize <= 0 || !expiresAt.After(time.Now().UTC()) {
		return recordingrender.DownloadableObject{}, ProtocolError{Err: errors.New("recording render download response")}
	}
	return recordingrender.DownloadableObject{ObjectFacts: recordingrender.ObjectFacts{ObjectKey: response.ObjectKey, ObjectVersion: response.ObjectVersion, ObjectETag: response.ObjectETag, ContentType: response.ContentType, ByteSize: response.ByteSize, SHA256: checksum}, Download: recordingrender.DownloadGrant{Method: response.Download.Method, URL: endpoint.String(), ExpiresAt: expiresAt, SignedHeaders: cloneUploadHeaders(response.Download.SignedHeaders)}}, nil
}

func decodeFinalizedRenderObject(input recordingrender.FinalizeObjectInput, response renderFinalizeResponse) (recordingrender.FinalizedObject, error) {
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

func decodeCommittedRenderObject(allocationID utilities.ID, response renderCommitObjectResponse) (recordingrender.CommittedObject, error) {
	responseID, idErr := utilities.ParseID(response.AllocationID)
	checksum, checksumErr := decodeExactLowerHex(response.SHA256)
	committedAt, timeErr := parseRequiredTime(response.CommittedAt)
	if errors.Join(idErr, checksumErr, timeErr) != nil || responseID != allocationID || response.AllocationVersion <= 0 || response.ByteSize <= 0 || strings.TrimSpace(response.ObjectKey) == "" || strings.TrimSpace(response.ObjectETag) == "" {
		return recordingrender.CommittedObject{}, ProtocolError{Err: errors.New("recording render committed object response")}
	}
	return recordingrender.CommittedObject{ReservedObject: recordingrender.ReservedObject{AllocationID: responseID, ObjectKey: response.ObjectKey, Purpose: recordingrender.ObjectPurpose(response.Purpose), AllocationVersion: response.AllocationVersion}, Object: recordingrender.ObjectFacts{ObjectKey: response.ObjectKey, ObjectVersion: response.ObjectVersion, ObjectETag: response.ObjectETag, ContentType: response.ContentType, ByteSize: response.ByteSize, SHA256: checksum}, DurationMillis: response.DurationMillis, CommittedAt: committedAt}, nil
}

func decodeTranscriptionPreparationCommit(input recordingrender.TranscriptionPreparationInput, response renderTranscriptionCommitResponse) (*recordingrender.TranscriptionResult, error) {
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

func decodeRenderCommit(input recordingrender.CommitInput, response renderCommitResponse) (recordingrender.CommitResult, error) {
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
