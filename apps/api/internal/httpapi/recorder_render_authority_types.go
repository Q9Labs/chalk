package httpapi

import "github.com/q9labs/chalk/apps/api/internal/recordingpipeline"

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

const recorderRenderCommitBodyLimit = 64 << 20

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
	VideoDegradation []recordingpipeline.VideoDegradation `json:"video_degradation,omitempty"`
	recorderRenderAuthorityBody
	CommitDigest        string                                 `json:"commit_digest"`
	PresentationSHA256  string                                 `json:"presentation_sha256"`
	DurationMillis      int64                                  `json:"duration_ms"`
	Video               recorderRenderObjectReferenceBody      `json:"video"`
	FFprobeFactsDigest  string                                 `json:"ffprobe_facts_digest"`
	TranscriptionSource *recorderRenderTranscriptionSourceBody `json:"transcription_source"`
}

type recorderTranscriptionPreparationCommitBody struct {
	recorderRenderAuthorityBody
	CommitDigest        string                                 `json:"commit_digest"`
	PresentationSHA256  string                                 `json:"presentation_sha256"`
	DurationMillis      int64                                  `json:"duration_ms"`
	TranscriptionSource *recorderRenderTranscriptionSourceBody `json:"transcription_source,omitempty"`
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
	BundleSchema         string  `json:"bundle_schema"`
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
	SchemaVersion     string                                `json:"schema_version"`
	TranscriptionMode string                                `json:"transcription_mode"`
	TenantID          string                                `json:"tenant_id"`
	SpaceID           string                                `json:"space_id"`
	EpisodeID         string                                `json:"episode_id"`
	RecordingID       string                                `json:"recording_id"`
	CaptureEpoch      int64                                 `json:"capture_epoch"`
	CaptureReadyAt    string                                `json:"capture_ready_at"`
	DurationMillis    int64                                 `json:"duration_ms"`
	Capture           []recorderRenderCaptureObjectResponse `json:"capture"`
	Presentation      recorderRenderPresentationResponse    `json:"presentation"`
	AssetManifest     recorderRenderObjectFactsResponse     `json:"asset_manifest"`
	Assets            []recorderRenderObjectFactsResponse   `json:"assets"`
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

type recorderTranscriptionPreparationCommitResponse struct {
	TranscriptionSourceID *string  `json:"transcription_source_id,omitempty"`
	TranscriptionJobIDs   []string `json:"transcription_job_ids"`
}
