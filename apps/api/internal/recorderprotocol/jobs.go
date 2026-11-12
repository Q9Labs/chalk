package recorderprotocol

import (
	"encoding/json"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/workerresources"
)

type ClaimRequest struct {
	ClaimRequestID         string `json:"claim_request_id"`
	LeaseForSeconds        int    `json:"lease_for_seconds"`
	SupportsCompletionOnly bool   `json:"supports_completion_only,omitempty"`
}

type CapturePlanWaitRequest struct {
	PlanHandle        string `json:"plan_handle"`
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
	AfterRevision     int64  `json:"after_revision"`
	WaitMilliseconds  int64  `json:"wait_milliseconds"`
}

type LeaseRequest struct {
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	LeaseToken        string `json:"lease_token"`
	LeaseForSeconds   int    `json:"lease_for_seconds"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
}

type ProgressRequest struct {
	LeaseRequest
	Stage     string `json:"stage"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
	Bytes     int64  `json:"bytes"`
	ObjectKey string `json:"object_key"`
}

type FailRequest struct {
	LeaseRequest
	AvailableAt string `json:"available_at"`
	ErrorCode   string `json:"error_code"`
	ErrorDetail string `json:"error_detail"`
}

type CompleteRequest struct {
	LeaseRequest
}

type PoolHealthRequest struct {
	AdmissionOpen bool   `json:"admission_open"`
	ReadyCapacity int    `json:"ready_capacity"`
	Reason        string `json:"reason"`
	// ObservedAt stays empty from workers: the API stamps the database receipt time.
	ObservedAt string                  `json:"observed_at,omitempty"`
	Resources  *workerresources.Sample `json:"resources,omitempty"`
}

type JobResponse struct {
	JobID             string  `json:"job_id"`
	TenantID          string  `json:"tenant_id"`
	EpisodeID         string  `json:"episode_id"`
	RecordingID       string  `json:"recording_id"`
	Kind              string  `json:"kind"`
	State             string  `json:"state"`
	AttemptCount      int     `json:"attempt_count"`
	AttemptLimit      int     `json:"attempt_limit"`
	LeaseToken        string  `json:"lease_token,omitempty"`
	LeaseOwner        string  `json:"lease_owner,omitempty"`
	LeaseExpiresAt    *string `json:"lease_expires_at,omitempty"`
	FencingGeneration int64   `json:"fencing_generation"`
	CaptureEpoch      int64   `json:"capture_epoch"`
	EnvelopeDigest    string  `json:"envelope_digest"`
	AvailableAt       string  `json:"available_at"`
	ErrorCode         string  `json:"error_code,omitempty"`
	ErrorDetail       string  `json:"error_detail,omitempty"`
	TerminalAt        *string `json:"terminal_at,omitempty"`
	UpdatedAt         string  `json:"updated_at"`
	CreatedAt         string  `json:"created_at"`
}

type ClaimResponse struct {
	ClaimRequestID string                                `json:"claim_request_id"`
	Envelope       recordingpipeline.RecorderJobEnvelope `json:"envelope"`
	EnvelopeDigest string                                `json:"envelope_digest"`
	LeaseToken     string                                `json:"lease_token"`
	LeaseOwner     string                                `json:"lease_owner"`
	LeaseExpiresAt string                                `json:"lease_expires_at"`
}

type CapturePlanResponse struct {
	Plan        json.RawMessage `json:"plan"`
	Fingerprint string          `json:"fingerprint"`
}

type ProgressResponse struct {
	Job       JobResponse `json:"job"`
	Stage     string      `json:"stage"`
	Completed int64       `json:"completed"`
	Total     int64       `json:"total"`
	Bytes     int64       `json:"bytes"`
	ObjectKey string      `json:"object_key,omitempty"`
}

type ArtifactResponse struct {
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
}

type PoolHealthResponse struct {
	Role          string `json:"role"`
	AdmissionOpen bool   `json:"admission_open"`
	ReadyCapacity int    `json:"ready_capacity"`
	Reason        string `json:"reason"`
	ObservedAt    string `json:"observed_at"`
	UpdatedAt     string `json:"updated_at"`
}

// NewCapturePlanResponse wraps a plan with the fingerprint the worker verifies after decoding it.
func NewCapturePlanResponse(plan captureplan.Plan) (CapturePlanResponse, error) {
	raw, err := json.Marshal(plan)
	if err != nil {
		return CapturePlanResponse{}, fmt.Errorf("encode capture plan: %w", err)
	}
	return CapturePlanResponse{Plan: raw, Fingerprint: plan.FingerprintHex()}, nil
}
