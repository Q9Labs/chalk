package httpapi

import (
	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workerresources"
)

type recorderWorkerClaimBody struct {
	ClaimRequestID         string `json:"claim_request_id"`
	LeaseForSeconds        int    `json:"lease_for_seconds"`
	SupportsCompletionOnly bool   `json:"supports_completion_only"`
}

type recorderWorkerCapturePlanWaitBody struct {
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

type recorderWorkerLeaseBody struct {
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	LeaseToken        string `json:"lease_token"`
	LeaseForSeconds   int    `json:"lease_for_seconds"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
}

type recorderWorkerProgressBody struct {
	recorderWorkerLeaseBody
	Stage     string `json:"stage"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
	Bytes     int64  `json:"bytes"`
	ObjectKey string `json:"object_key"`
}

type recorderWorkerFailBody struct {
	recorderWorkerLeaseBody
	AvailableAt string `json:"available_at"`
	ErrorCode   string `json:"error_code"`
	ErrorDetail string `json:"error_detail"`
}

type recorderWorkerCompleteBody struct {
	recorderWorkerLeaseBody
}

type recorderWorkerPoolHealthBody struct {
	AdmissionOpen bool                    `json:"admission_open"`
	ReadyCapacity int                     `json:"ready_capacity"`
	Reason        string                  `json:"reason"`
	ObservedAt    string                  `json:"observed_at"`
	Resources     *workerresources.Sample `json:"resources,omitempty"`
}

type recorderWorkerJobResponse struct {
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

type recorderWorkerClaimResponse struct {
	ClaimRequestID string                                `json:"claim_request_id"`
	Envelope       recordingpipeline.RecorderJobEnvelope `json:"envelope"`
	EnvelopeDigest string                                `json:"envelope_digest"`
	LeaseToken     string                                `json:"lease_token"`
	LeaseOwner     string                                `json:"lease_owner"`
	LeaseExpiresAt string                                `json:"lease_expires_at"`
}

type recorderWorkerCapturePlanResponse struct {
	Plan        captureplan.Plan `json:"plan"`
	Fingerprint string           `json:"fingerprint"`
}

type recorderWorkerProgressResponse struct {
	Job       recorderWorkerJobResponse `json:"job"`
	Stage     string                    `json:"stage"`
	Complete  int64                     `json:"completed"`
	Total     int64                     `json:"total"`
	Bytes     int64                     `json:"bytes"`
	ObjectKey string                    `json:"object_key,omitempty"`
}

type recorderWorkerArtifactResponse struct {
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

type recorderWorkerPoolHealthResponse struct {
	Role          string `json:"role"`
	AdmissionOpen bool   `json:"admission_open"`
	ReadyCapacity int    `json:"ready_capacity"`
	Reason        string `json:"reason"`
	ObservedAt    string `json:"observed_at"`
	UpdatedAt     string `json:"updated_at"`
}

func recorderWorkerJobResponseValue(job recordingpipeline.Job) recorderWorkerJobResponse {
	response := recorderWorkerJobResponse{JobID: job.ID.String(), TenantID: job.TenantID.String(), EpisodeID: job.EpisodeID.String(), RecordingID: job.RecordingID.String(), Kind: string(job.Kind), State: string(job.State), AttemptCount: job.AttemptCount, AttemptLimit: job.AttemptLimit, FencingGeneration: job.FencingGeneration, CaptureEpoch: job.CaptureEpoch, AvailableAt: utilities.FormatTimestamp(job.AvailableAt), UpdatedAt: utilities.FormatTimestamp(job.UpdatedAt), CreatedAt: utilities.FormatTimestamp(job.CreatedAt)}
	if job.Authority != nil {
		response.EnvelopeDigest = recordingpipeline.EnvelopeDigestHex(job.Authority.EnvelopeDigest)
	}
	if job.LeaseToken != nil {
		response.LeaseToken = *job.LeaseToken
	}
	if job.LeaseOwner != nil {
		response.LeaseOwner = *job.LeaseOwner
	}
	if job.LeaseExpiresAt != nil {
		value := utilities.FormatTimestamp(*job.LeaseExpiresAt)
		response.LeaseExpiresAt = &value
	}
	if job.ErrorCode != nil {
		response.ErrorCode = *job.ErrorCode
	}
	if job.ErrorDetail != nil {
		response.ErrorDetail = *job.ErrorDetail
	}
	if job.TerminalAt != nil {
		value := utilities.FormatTimestamp(*job.TerminalAt)
		response.TerminalAt = &value
	}
	return response
}

func recorderWorkerArtifactResponseValue(artifact recordingpipeline.Artifact) recorderWorkerArtifactResponse {
	return recorderWorkerArtifactResponse{RecordingID: artifact.RecordingID.String(), TenantID: artifact.TenantID.String(), RenderJobID: artifact.RenderJobID.String(), ObjectKey: artifact.ObjectKey, ContentType: artifact.ContentType, ByteSize: artifact.ByteSize, Checksum: checksumString(artifact.Checksum), DurationMillis: artifact.Duration.Milliseconds(), CommittedAt: utilities.FormatTimestamp(artifact.CommittedAt), CreatedAt: utilities.FormatTimestamp(artifact.CreatedAt)}
}

func recorderWorkerPoolHealthResponseValue(health recordingpipeline.PoolHealth) recorderWorkerPoolHealthResponse {
	return recorderWorkerPoolHealthResponse{Role: string(health.Role), AdmissionOpen: health.AdmissionOpen, ReadyCapacity: health.ReadyCapacity, Reason: health.Reason, ObservedAt: utilities.FormatTimestamp(health.ObservedAt), UpdatedAt: utilities.FormatTimestamp(health.UpdatedAt)}
}
