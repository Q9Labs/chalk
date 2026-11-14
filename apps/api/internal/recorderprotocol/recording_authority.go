package recorderprotocol

type RecordingAuthority struct {
	TenantID          string `json:"tenant_id"`
	EpisodeID         string `json:"episode_id"`
	RecordingID       string `json:"recording_id"`
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
	LeaseToken        string `json:"lease_token"`
	LeaseOwner        string `json:"lease_owner"`
	LeaseExpiresAt    string `json:"lease_expires_at"`
}

type RecordingKeyAccessRequest struct {
	RecordingAuthority
	KeyHandle string `json:"key_handle"`
}

type RecordingObjectAuthority struct {
	RecordingAuthority
	ObjectHandle string `json:"object_handle"`
}

type RecordingObjectReserveRequest struct {
	RecordingObjectAuthority
	ReservationRequestID    string `json:"reservation_request_id"`
	EncryptionContextDigest string `json:"encryption_context_digest"`
}

type RecordingObjectFinalizeRequest struct {
	RecordingObjectAuthority
	AllocationID         string  `json:"allocation_id"`
	ByteSize             int64   `json:"byte_size"`
	ChecksumSHA256       string  `json:"checksum_sha256"`
	ContentType          string  `json:"content_type"`
	Codec                string  `json:"codec"`
	Layer                *string `json:"layer"`
	MonotonicStartMillis int64   `json:"monotonic_start_millis"`
	MonotonicEndMillis   int64   `json:"monotonic_end_millis"`
	MediaStartMillis     int64   `json:"media_start_millis"`
	MediaEndMillis       int64   `json:"media_end_millis"`
}

type RecordingObjectCommitRequest struct {
	RecordingObjectAuthority
	AllocationID         string `json:"allocation_id"`
	UploadToken          string `json:"upload_token"`
	ManifestDigest       string `json:"manifest_digest"`
	MonotonicStartMillis int64  `json:"monotonic_start_millis"`
	MonotonicEndMillis   int64  `json:"monotonic_end_millis"`
	MediaStartMillis     int64  `json:"media_start_millis"`
	MediaEndMillis       int64  `json:"media_end_millis"`
}

type RecordingKeyAccessResponse struct {
	KeyHandle        string `json:"key_handle"`
	Plaintext        string `json:"plaintext"`
	CiphertextDigest string `json:"ciphertext_digest"`
	ContextDigest    string `json:"context_digest"`
	CaptureEpoch     int64  `json:"capture_epoch"`
}

type RecordingObjectReserveResponse struct {
	AllocationID      string `json:"allocation_id"`
	ObjectKey         string `json:"object_key"`
	SequenceNumber    int64  `json:"sequence_number"`
	AllocationVersion int64  `json:"allocation_version"`
}

type SignedUploadResponse struct {
	Method        string              `json:"method"`
	URL           string              `json:"url"`
	ExpiresAt     string              `json:"expires_at"`
	SignedHeaders map[string][]string `json:"signed_headers"`
}

type RecordingObjectFinalizeResponse struct {
	AllocationID string               `json:"allocation_id"`
	UploadToken  string               `json:"upload_token"`
	Upload       SignedUploadResponse `json:"upload"`
	ExpiresAt    string               `json:"expires_at"`
}

type RecordingObjectCommitResponse struct {
	AllocationID      string `json:"allocation_id"`
	ObjectKey         string `json:"object_key"`
	SequenceNumber    int64  `json:"sequence_number"`
	AllocationVersion int64  `json:"allocation_version"`
	ObjectVersion     string `json:"object_version"`
	ObjectETag        string `json:"object_etag"`
	ObjectChecksum    string `json:"object_checksum_sha256"`
	ManifestDigest    string `json:"manifest_digest"`
	CommittedAt       string `json:"committed_at"`
}
