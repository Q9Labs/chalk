package recorderworker

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

const (
	ControlPlaneRequestLimit  = 2 << 20
	ControlPlaneResponseLimit = 2 << 20
)

var (
	ErrInvalidControlPlaneClient  = errors.New("invalid recorder control-plane client")
	ErrInvalidControlPlaneRequest = errors.New("invalid recorder control-plane request")
	ErrControlPlaneProtocol       = errors.New("invalid recorder control-plane response")
	ErrControlPlaneRetryable      = errors.New("recorder control-plane request is retryable")
	ErrControlPlaneFenced         = errors.New("recorder control-plane request is fenced")
	ErrControlPlaneTerminal       = errors.New("recorder control-plane request is terminal")
	ErrNoWork                     = errors.New("recorder control plane has no work")
	ErrNoChange                   = errors.New("recorder control plane has no plan change")
)

// HTTPError classifies an HTTP response without retaining its body. The
// control plane uses 409/412 as fences, other 4xx responses as terminal, and
// 429/5xx responses as retryable.
type HTTPError struct {
	Status    int
	Retryable bool
	Fenced    bool
	Terminal  bool
}

func (e HTTPError) Error() string {
	return fmt.Sprintf("recorder control-plane request failed with HTTP status %d", e.Status)
}

func (e HTTPError) Is(target error) bool {
	switch target {
	case ErrControlPlaneRetryable:
		return e.Retryable
	case ErrControlPlaneFenced:
		return e.Fenced
	case ErrControlPlaneTerminal:
		return e.Terminal
	default:
		return false
	}
}

// TransportError intentionally does not include the underlying error in its
// text. It can still be inspected with errors.Is and is always retryable.
type TransportError struct{ Err error }

func (e TransportError) Error() string { return "recorder control-plane transport failed" }

func (e TransportError) Unwrap() error { return e.Err }

func (e TransportError) Is(target error) bool { return target == ErrControlPlaneRetryable }

type ProtocolError struct{ Err error }

func (e ProtocolError) Error() string { return ErrControlPlaneProtocol.Error() }

func (e ProtocolError) Unwrap() error { return errors.Join(ErrControlPlaneProtocol, e.Err) }

type NoWorkError struct{}

func (NoWorkError) Error() string { return ErrNoWork.Error() }

func (NoWorkError) Is(target error) bool { return target == ErrNoWork }

type NoChangeError struct{}

func (NoChangeError) Error() string { return ErrNoChange.Error() }

func (NoChangeError) Is(target error) bool { return target == ErrNoChange }

// ControlPlaneClient is the private recorder worker client. The HTTP client
// is supplied by the caller so mTLS and its transport policy remain outside
// this package.
type ControlPlaneClient struct {
	baseURL  *url.URL
	client   *http.Client
	uploader *http.Client
}

// Client is a short alias for callers that use the generic client name.
type Client = ControlPlaneClient

func NewControlPlaneClient(baseURL string, client *http.Client) (*ControlPlaneClient, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("%w: base URL: %v", ErrInvalidControlPlaneClient, err)
	}
	return NewControlPlaneClientWithURL(parsed, client)
}

func NewControlPlaneClientWithURL(baseURL *url.URL, client *http.Client) (*ControlPlaneClient, error) {
	return NewControlPlaneClientWithURLAndUploader(baseURL, client, &http.Client{Timeout: 30 * time.Second})
}

func NewControlPlaneClientWithUploader(baseURL string, client, uploader *http.Client) (*ControlPlaneClient, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("%w: base URL: %v", ErrInvalidControlPlaneClient, err)
	}
	return NewControlPlaneClientWithURLAndUploader(parsed, client, uploader)
}

func NewControlPlaneClientWithURLAndUploader(baseURL *url.URL, client, uploader *http.Client) (*ControlPlaneClient, error) {
	if baseURL == nil || client == nil || uploader == nil || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, ErrInvalidControlPlaneClient
	}
	if baseURL.Scheme != "https" {
		return nil, ErrInvalidControlPlaneClient
	}
	clone := *baseURL
	clone.Path = strings.TrimRight(clone.Path, "/")
	clone.RawPath = ""
	httpClient := *client
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	uploadClient := *uploader
	uploadClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &ControlPlaneClient{baseURL: &clone, client: &httpClient, uploader: &uploadClient}, nil
}

func NewClient(baseURL string, client *http.Client) (*ControlPlaneClient, error) {
	return NewControlPlaneClient(baseURL, client)
}

type ClaimResult struct {
	ClaimRequestID utilities.ID
	Envelope       recordingpipeline.RecorderJobEnvelope
	EnvelopeDigest []byte
	LeaseToken     string
	LeaseOwner     string
	LeaseExpiresAt time.Time
}

type ProgressInput struct {
	Lease     recordingpipeline.LeaseInput
	Stage     string
	Completed int64
	Total     int64
	Bytes     int64
	ObjectKey string
}

type ProgressResult struct {
	Job       recordingpipeline.Job
	Stage     string
	Completed int64
	Total     int64
	Bytes     int64
	ObjectKey string
}

type recorderWorkerClaimRequest struct {
	ClaimRequestID  string `json:"claim_request_id"`
	LeaseForSeconds int    `json:"lease_for_seconds"`
}

type recorderWorkerLeaseRequest struct {
	JobID             string `json:"job_id"`
	AttemptCount      int    `json:"attempt_count"`
	FencingGeneration int64  `json:"fencing_generation"`
	LeaseToken        string `json:"lease_token"`
	LeaseForSeconds   int    `json:"lease_for_seconds"`
	CaptureEpoch      int64  `json:"capture_epoch"`
	EnvelopeDigest    string `json:"envelope_digest"`
}

type recorderWorkerProgressRequest struct {
	recorderWorkerLeaseRequest
	Stage     string `json:"stage"`
	Completed int64  `json:"completed"`
	Total     int64  `json:"total"`
	Bytes     int64  `json:"bytes"`
	ObjectKey string `json:"object_key"`
}

type recorderWorkerFailRequest struct {
	recorderWorkerLeaseRequest
	AvailableAt string `json:"available_at"`
	ErrorCode   string `json:"error_code"`
	ErrorDetail string `json:"error_detail"`
}

type recorderWorkerPlanRequest struct {
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

type recorderWorkerBundleRequest struct {
	TenantID             string  `json:"tenant_id"`
	RecordingID          string  `json:"recording_id"`
	CaptureJobID         string  `json:"capture_job_id"`
	SequenceNumber       int64   `json:"sequence_number"`
	FencingGeneration    int64   `json:"fencing_generation"`
	AttemptCount         int     `json:"attempt_count"`
	LeaseToken           string  `json:"lease_token"`
	CaptureEpoch         int64   `json:"capture_epoch"`
	EnvelopeDigest       string  `json:"envelope_digest"`
	ObjectKey            string  `json:"object_key"`
	ContentType          string  `json:"content_type"`
	Codec                string  `json:"codec"`
	Layer                *string `json:"layer"`
	ByteSize             int64   `json:"byte_size"`
	Checksum             string  `json:"checksum"`
	MonotonicStartMillis int64   `json:"monotonic_start_millis"`
	MonotonicEndMillis   int64   `json:"monotonic_end_millis"`
	MediaStartMillis     int64   `json:"media_start_millis"`
	MediaEndMillis       int64   `json:"media_end_millis"`
}

type recorderWorkerClaimResponse struct {
	ClaimRequestID string                                `json:"claim_request_id"`
	Envelope       recordingpipeline.RecorderJobEnvelope `json:"envelope"`
	EnvelopeDigest string                                `json:"envelope_digest"`
	LeaseToken     string                                `json:"lease_token"`
	LeaseOwner     string                                `json:"lease_owner"`
	LeaseExpiresAt string                                `json:"lease_expires_at"`
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

type recorderWorkerProgressResponse struct {
	Job       recorderWorkerJobResponse `json:"job"`
	Completed int64                     `json:"completed"`
	Stage     string                    `json:"stage"`
	Total     int64                     `json:"total"`
	Bytes     int64                     `json:"bytes"`
	ObjectKey string                    `json:"object_key,omitempty"`
}

type recorderWorkerBundleResponse struct {
	ID                   string  `json:"id"`
	TenantID             string  `json:"tenant_id"`
	RecordingID          string  `json:"recording_id"`
	CaptureJobID         string  `json:"capture_job_id"`
	SequenceNumber       int64   `json:"sequence_number"`
	FencingGeneration    int64   `json:"fencing_generation"`
	ObjectKey            string  `json:"object_key"`
	ContentType          string  `json:"content_type"`
	Codec                string  `json:"codec"`
	Layer                *string `json:"layer,omitempty"`
	ByteSize             int64   `json:"byte_size"`
	Checksum             string  `json:"checksum"`
	MonotonicStartMillis int64   `json:"monotonic_start_millis"`
	MonotonicEndMillis   int64   `json:"monotonic_end_millis"`
	MediaStartMillis     int64   `json:"media_start_millis"`
	MediaEndMillis       int64   `json:"media_end_millis"`
	CreatedAt            string  `json:"created_at"`
}

type recorderWorkerCapturePlanResponse struct {
	Plan        json.RawMessage `json:"plan"`
	Fingerprint string          `json:"fingerprint"`
}

func (c *ControlPlaneClient) Claim(ctx context.Context, input recordingpipeline.ClaimInput) (ClaimResult, error) {
	leaseSeconds, err := durationSeconds(input.LeaseFor)
	if err != nil || input.ClaimRequestID.IsZero() {
		return ClaimResult{}, fmt.Errorf("%w: claim input", ErrInvalidControlPlaneRequest)
	}
	payload := recorderWorkerClaimRequest{ClaimRequestID: input.ClaimRequestID.String(), LeaseForSeconds: leaseSeconds}
	body, status, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/jobs/claim", payload, ControlPlaneResponseLimit)
	if err != nil {
		return ClaimResult{}, err
	}
	if status == http.StatusNoContent {
		return ClaimResult{}, NoWorkError{}
	}
	var response recorderWorkerClaimResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return ClaimResult{}, ProtocolError{Err: err}
	}
	return decodeClaimResult(input.ClaimRequestID, response)
}

func (c *ControlPlaneClient) ClaimJob(ctx context.Context, claimRequestID utilities.ID, leaseFor time.Duration) (ClaimResult, error) {
	return c.Claim(ctx, recordingpipeline.ClaimInput{ClaimRequestID: claimRequestID, LeaseFor: leaseFor})
}

func (c *ControlPlaneClient) Heartbeat(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	payload, err := leaseRequest(input)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/jobs/heartbeat", payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	var response recorderWorkerJobResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: err}
	}
	job, err := decodeJob(response)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	if err := verifyJobAuthority(job, input); err != nil {
		return recordingpipeline.Job{}, err
	}
	return job, nil
}

func (c *ControlPlaneClient) Progress(ctx context.Context, input ProgressInput) (ProgressResult, error) {
	lease, err := leaseRequest(input.Lease)
	if err != nil {
		return ProgressResult{}, err
	}
	payload := recorderWorkerProgressRequest{recorderWorkerLeaseRequest: lease, Stage: input.Stage, Completed: input.Completed, Total: input.Total, Bytes: input.Bytes, ObjectKey: input.ObjectKey}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/jobs/progress", payload, ControlPlaneResponseLimit)
	if err != nil {
		return ProgressResult{}, err
	}
	var response recorderWorkerProgressResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return ProgressResult{}, ProtocolError{Err: err}
	}
	job, err := decodeJob(response.Job)
	if err != nil {
		return ProgressResult{}, err
	}
	if err := verifyJobAuthority(job, input.Lease); err != nil {
		return ProgressResult{}, err
	}
	return ProgressResult{Job: job, Stage: response.Stage, Completed: response.Completed, Total: response.Total, Bytes: response.Bytes, ObjectKey: response.ObjectKey}, nil
}

func (c *ControlPlaneClient) Fail(ctx context.Context, input recordingpipeline.FailureInput) (recordingpipeline.Job, error) {
	lease, err := leaseRequest(input.LeaseInput)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	payload := recorderWorkerFailRequest{recorderWorkerLeaseRequest: lease, ErrorCode: input.ErrorCode, ErrorDetail: input.ErrorDetail}
	if !input.AvailableAt.IsZero() {
		payload.AvailableAt = input.AvailableAt.UTC().Format(time.RFC3339Nano)
	}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/jobs/fail", payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	var response recorderWorkerJobResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: err}
	}
	job, err := decodeJob(response)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	if err := verifyJobAuthority(job, input.LeaseInput); err != nil {
		return recordingpipeline.Job{}, err
	}
	return job, nil
}

func (c *ControlPlaneClient) Complete(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	payload, err := leaseRequest(input)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/jobs/complete", payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	var response recorderWorkerJobResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: err}
	}
	job, err := decodeJob(response)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	if err := verifyJobAuthority(job, input); err != nil {
		return recordingpipeline.Job{}, err
	}
	return job, nil
}

func (c *ControlPlaneClient) Wait(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	if err := input.Validate(time.Now().UTC()); err != nil {
		return captureplan.Plan{}, fmt.Errorf("%w: plan wait: %v", ErrInvalidControlPlaneRequest, err)
	}
	payload := recorderWorkerPlanRequest{
		PlanHandle: string(input.PlanHandle), TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(),
		EpisodeID: input.EpisodeID.String(), RecordingID: input.RecordingID.String(), JobID: input.JobID.String(),
		AttemptCount: input.AttemptCount, FencingGeneration: input.FencingGeneration,
		CaptureEpoch: int64(input.CaptureEpoch), EnvelopeDigest: hex.EncodeToString(input.EnvelopeDigest),
		LeaseToken: input.LeaseToken, LeaseExpiresAt: input.LeaseExpiresAt.UTC().Format(time.RFC3339Nano),
		AfterRevision: int64(input.AfterRevision), WaitMilliseconds: input.MaxWait.Milliseconds(),
	}
	body, status, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/plans/wait", payload, ControlPlaneResponseLimit)
	if err != nil {
		return captureplan.Plan{}, err
	}
	if status == http.StatusNoContent {
		return captureplan.Plan{}, NoChangeError{}
	}
	var response recorderWorkerCapturePlanResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return captureplan.Plan{}, ProtocolError{Err: err}
	}
	plan, err := captureplan.DecodePlan(response.Plan, response.Fingerprint)
	if err != nil {
		return captureplan.Plan{}, ProtocolError{Err: err}
	}
	if err := verifyPlanAuthority(plan, input); err != nil {
		return captureplan.Plan{}, err
	}
	return plan, nil
}

func (c *ControlPlaneClient) WaitForPlan(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	return c.Wait(ctx, input)
}

func (c *ControlPlaneClient) CommitBundle(ctx context.Context, input recordingpipeline.BundleInput) (recordingpipeline.Bundle, error) {
	payload, err := bundleRequest(input)
	if err != nil {
		return recordingpipeline.Bundle{}, err
	}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/bundles", payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingpipeline.Bundle{}, err
	}
	var response recorderWorkerBundleResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingpipeline.Bundle{}, ProtocolError{Err: err}
	}
	bundle, err := decodeBundle(response)
	if err != nil {
		return recordingpipeline.Bundle{}, err
	}
	if err := verifyBundleAuthority(bundle, input); err != nil {
		return recordingpipeline.Bundle{}, err
	}
	return bundle, nil
}

func (c *ControlPlaneClient) InsertBundle(ctx context.Context, input recordingpipeline.BundleInput) (recordingpipeline.Bundle, error) {
	return c.CommitBundle(ctx, input)
}

// Execute sends one typed CapturePlane command through one of the six private
// signaling routes. The command identity is copied into the body unchanged,
// which makes retries use the same durable idempotency key.
func (c *ControlPlaneClient) Execute(ctx context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	return c.ExecuteCapture(ctx, request.Command)
}

func (c *ControlPlaneClient) ExecuteCapture(ctx context.Context, command capturesignaling.Command) (capturesignaling.Execution, error) {
	requestBody, operation, err := signalingRequest(command)
	if err != nil {
		return capturesignaling.Execution{}, err
	}
	path := map[captureplane.OperationKind]string{
		captureplane.OperationCreateCaptureConnection:      "/internal/v1/recorder/capture/create",
		captureplane.OperationPullCaptureTracks:            "/internal/v1/recorder/capture/pull",
		captureplane.OperationRenegotiateCaptureConnection: "/internal/v1/recorder/capture/renegotiate",
		captureplane.OperationInspectCaptureConnection:     "/internal/v1/recorder/capture/inspect",
		captureplane.OperationCloseCaptureTracks:           "/internal/v1/recorder/capture/close-tracks",
		captureplane.OperationCloseCaptureConnection:       "/internal/v1/recorder/capture/close-connection",
	}[operation]
	body, _, err := c.do(ctx, http.MethodPost, path, requestBody, ControlPlaneResponseLimit)
	if err != nil {
		return capturesignaling.Execution{}, err
	}
	var response recorderCaptureSignalingResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return capturesignaling.Execution{}, ProtocolError{Err: err}
	}
	resultBytes, err := json.Marshal(response.Result)
	if err != nil {
		return capturesignaling.Execution{}, ProtocolError{Err: err}
	}
	metadata := captureplane.OperationMetadata{
		Identity:     captureplane.CaptureIdentity{TenantID: command.Authority.TenantID, SpaceID: command.Authority.SpaceID, EpisodeID: command.Authority.EpisodeID, RecordingID: command.Authority.RecordingID},
		CaptureEpoch: command.Authority.CaptureEpoch, PlanRevision: command.Identity.PlanRevision, IdempotencyKey: command.Identity.IdempotencyKey,
	}
	result, err := capturesignaling.DecodeResult(resultBytes, operation, metadata)
	if err != nil {
		return capturesignaling.Execution{}, ProtocolError{Err: err}
	}
	return capturesignaling.Execution{
		Key:    capturesignaling.CommandKey{SignalingHandle: command.SignalingHandle, Operation: operation, PlanRevision: command.Identity.PlanRevision, IdempotencyKey: command.Identity.IdempotencyKey},
		Result: result, ResultBytes: resultBytes, Replayed: response.Replayed,
	}, nil
}

type recorderCaptureAuthorityRequest struct {
	SignalingHandle   string `json:"signaling_handle"`
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
	PlanRevision      int64  `json:"plan_revision"`
	IdempotencyKey    string `json:"idempotency_key"`
}

type recorderCapturePullRequest struct {
	recorderCaptureAuthorityRequest
	Connection       string                        `json:"connection"`
	Tracks           []recorderCaptureTrackRequest `json:"tracks"`
	LocalDescription *captureplane.Description     `json:"local_description,omitempty"`
}

type recorderCaptureRenegotiateRequest struct {
	recorderCaptureAuthorityRequest
	Connection    string                   `json:"connection"`
	NegotiationID string                   `json:"negotiation_id"`
	Description   captureplane.Description `json:"description"`
}

type recorderCaptureInspectRequest struct {
	recorderCaptureAuthorityRequest
	Connection string                              `json:"connection"`
	Tracks     []recorderCapturePulledTrackRequest `json:"tracks,omitempty"`
}

type recorderCaptureCloseTracksRequest struct {
	recorderCaptureAuthorityRequest
	Connection string                              `json:"connection"`
	Tracks     []recorderCapturePulledTrackRequest `json:"tracks"`
}

type recorderCaptureCloseConnectionRequest struct {
	recorderCaptureAuthorityRequest
	Connection string                              `json:"connection"`
	Tracks     []recorderCapturePulledTrackRequest `json:"tracks,omitempty"`
	Force      bool                                `json:"force"`
}

type recorderCaptureTrackRequest struct {
	OwnerReference        string `json:"owner_reference"`
	TrackReference        string `json:"track_reference"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
	Source                string `json:"source"`
	Kind                  string `json:"kind"`
	RequestedLayer        string `json:"requested_layer"`
}

type recorderCapturePulledTrackRequest struct {
	OwnerReference        string `json:"owner_reference"`
	TrackReference        string `json:"track_reference"`
	ParticipantID         string `json:"participant_id"`
	ParticipantGeneration int64  `json:"participant_generation"`
	Source                string `json:"source"`
	Kind                  string `json:"kind"`
	RequestedLayer        string `json:"requested_layer"`
	MID                   string `json:"mid"`
}

type recorderCaptureSignalingResponse struct {
	Replayed bool                           `json:"replayed"`
	Result   capturesignaling.CommandResult `json:"result"`
}

func signalingRequest(command capturesignaling.Command) (any, captureplane.OperationKind, error) {
	if _, _, err := capturesignaling.CanonicalRequest(command); err != nil {
		return nil, "", fmt.Errorf("%w: capture signaling: %v", ErrInvalidControlPlaneRequest, err)
	}
	base := recorderCaptureAuthorityRequest{
		SignalingHandle: command.SignalingHandle.String(), TenantID: command.Authority.TenantID.String(), SpaceID: command.Authority.SpaceID.String(),
		EpisodeID: command.Authority.EpisodeID.String(), RecordingID: command.Authority.RecordingID.String(), JobID: command.Authority.JobID.String(),
		AttemptCount: command.Authority.AttemptCount, FencingGeneration: command.Authority.FencingGeneration,
		CaptureEpoch: int64(command.Authority.CaptureEpoch), EnvelopeDigest: hex.EncodeToString(command.Authority.EnvelopeDigest),
		LeaseToken: command.Lease.Token, LeaseExpiresAt: command.Lease.ExpiresAt.UTC().Format(time.RFC3339Nano),
		PlanRevision: int64(command.Identity.PlanRevision), IdempotencyKey: command.Identity.IdempotencyKey,
	}
	switch command.Identity.Operation {
	case captureplane.OperationCreateCaptureConnection:
		if command.Input.CreateCaptureConnection == nil {
			return nil, "", fmt.Errorf("%w: create input", ErrInvalidControlPlaneRequest)
		}
		return base, command.Identity.Operation, nil
	case captureplane.OperationPullCaptureTracks:
		value := command.Input.PullCaptureTracks
		if value == nil {
			return nil, "", fmt.Errorf("%w: pull input", ErrInvalidControlPlaneRequest)
		}
		return recorderCapturePullRequest{recorderCaptureAuthorityRequest: base, Connection: value.Connection.String(), Tracks: captureTrackRequests(value.Tracks), LocalDescription: value.LocalDescription}, command.Identity.Operation, nil
	case captureplane.OperationRenegotiateCaptureConnection:
		value := command.Input.RenegotiateCaptureConnection
		if value == nil {
			return nil, "", fmt.Errorf("%w: renegotiate input", ErrInvalidControlPlaneRequest)
		}
		return recorderCaptureRenegotiateRequest{recorderCaptureAuthorityRequest: base, Connection: value.Connection.String(), NegotiationID: value.NegotiationID.String(), Description: value.Description}, command.Identity.Operation, nil
	case captureplane.OperationInspectCaptureConnection:
		value := command.Input.InspectCaptureConnection
		if value == nil {
			return nil, "", fmt.Errorf("%w: inspect input", ErrInvalidControlPlaneRequest)
		}
		return recorderCaptureInspectRequest{recorderCaptureAuthorityRequest: base, Connection: value.Connection.String(), Tracks: pulledTrackRequests(value.Tracks)}, command.Identity.Operation, nil
	case captureplane.OperationCloseCaptureTracks:
		value := command.Input.CloseCaptureTracks
		if value == nil {
			return nil, "", fmt.Errorf("%w: close tracks input", ErrInvalidControlPlaneRequest)
		}
		return recorderCaptureCloseTracksRequest{recorderCaptureAuthorityRequest: base, Connection: value.Connection.String(), Tracks: pulledTrackRequests(value.Tracks)}, command.Identity.Operation, nil
	case captureplane.OperationCloseCaptureConnection:
		value := command.Input.CloseCaptureConnection
		if value == nil {
			return nil, "", fmt.Errorf("%w: close connection input", ErrInvalidControlPlaneRequest)
		}
		return recorderCaptureCloseConnectionRequest{recorderCaptureAuthorityRequest: base, Connection: value.Connection.String(), Tracks: pulledTrackRequests(value.Tracks), Force: value.Force}, command.Identity.Operation, nil
	default:
		return nil, "", fmt.Errorf("%w: operation", ErrInvalidControlPlaneRequest)
	}
}

func captureTrackRequests(values []captureplane.CaptureTrack) []recorderCaptureTrackRequest {
	result := make([]recorderCaptureTrackRequest, len(values))
	for index, value := range values {
		result[index] = recorderCaptureTrackRequest{OwnerReference: value.OwnerReference.String(), TrackReference: value.TrackReference.String(), ParticipantID: value.ParticipantID.String(), ParticipantGeneration: value.ParticipantGeneration, Source: value.Source.String(), Kind: value.Kind.String(), RequestedLayer: value.RequestedLayer.String()}
	}
	return result
}

func pulledTrackRequests(values []captureplane.PulledCaptureTrack) []recorderCapturePulledTrackRequest {
	result := make([]recorderCapturePulledTrackRequest, len(values))
	for index, value := range values {
		result[index] = recorderCapturePulledTrackRequest{OwnerReference: value.OwnerReference.String(), TrackReference: value.TrackReference.String(), ParticipantID: value.ParticipantID.String(), ParticipantGeneration: value.ParticipantGeneration, Source: value.Source.String(), Kind: value.Kind.String(), RequestedLayer: value.RequestedLayer.String(), MID: value.MID.String()}
	}
	return result
}

func leaseRequest(input recordingpipeline.LeaseInput) (recorderWorkerLeaseRequest, error) {
	seconds, err := durationSeconds(input.LeaseFor)
	if err != nil || input.JobID.IsZero() || input.AttemptCount < 1 || input.FencingGeneration < 1 || input.CaptureEpoch < 1 || strings.TrimSpace(input.LeaseToken) == "" || len(input.EnvelopeDigest) != 32 {
		return recorderWorkerLeaseRequest{}, fmt.Errorf("%w: lease input", ErrInvalidControlPlaneRequest)
	}
	return recorderWorkerLeaseRequest{JobID: input.JobID.String(), AttemptCount: input.AttemptCount, FencingGeneration: input.FencingGeneration, LeaseToken: input.LeaseToken, LeaseForSeconds: seconds, CaptureEpoch: input.CaptureEpoch, EnvelopeDigest: hex.EncodeToString(input.EnvelopeDigest)}, nil
}

func bundleRequest(input recordingpipeline.BundleInput) (recorderWorkerBundleRequest, error) {
	if input.TenantID.IsZero() || input.RecordingID.IsZero() || input.CaptureJobID.IsZero() || input.AttemptCount < 1 || input.FencingGeneration < 1 || input.CaptureEpoch < 1 || strings.TrimSpace(input.LeaseToken) == "" || len(input.EnvelopeDigest) != 32 {
		return recorderWorkerBundleRequest{}, fmt.Errorf("%w: bundle input", ErrInvalidControlPlaneRequest)
	}
	return recorderWorkerBundleRequest{TenantID: input.TenantID.String(), RecordingID: input.RecordingID.String(), CaptureJobID: input.CaptureJobID.String(), SequenceNumber: input.SequenceNumber, FencingGeneration: input.FencingGeneration, AttemptCount: input.AttemptCount, LeaseToken: input.LeaseToken, CaptureEpoch: input.CaptureEpoch, EnvelopeDigest: hex.EncodeToString(input.EnvelopeDigest), ObjectKey: input.ObjectKey, ContentType: input.ContentType, Codec: input.Codec, Layer: input.Layer, ByteSize: input.ByteSize, Checksum: hex.EncodeToString(input.Checksum), MonotonicStartMillis: input.MonotonicStartMillis, MonotonicEndMillis: input.MonotonicEndMillis, MediaStartMillis: input.MediaStartMillis, MediaEndMillis: input.MediaEndMillis}, nil
}

func decodeClaimResult(requestID utilities.ID, response recorderWorkerClaimResponse) (ClaimResult, error) {
	claimID, err := utilities.ParseID(response.ClaimRequestID)
	if err != nil || claimID != requestID || strings.TrimSpace(response.LeaseToken) == "" || strings.TrimSpace(response.LeaseOwner) == "" {
		return ClaimResult{}, ProtocolError{Err: errors.New("claim response identity")}
	}
	digest, err := decodeHex(response.EnvelopeDigest, 32)
	if err != nil {
		return ClaimResult{}, ProtocolError{Err: errors.New("claim response digest")}
	}
	envelopeBytes, err := json.Marshal(response.Envelope)
	if err != nil {
		return ClaimResult{}, ProtocolError{Err: err}
	}
	envelope, err := recordingpipeline.DecodeRecorderJobEnvelope(envelopeBytes, digest)
	if err != nil {
		return ClaimResult{}, ProtocolError{Err: err}
	}
	leaseExpiresAt, err := parseRequiredTime(response.LeaseExpiresAt)
	if err != nil {
		return ClaimResult{}, ProtocolError{Err: err}
	}
	return ClaimResult{ClaimRequestID: claimID, Envelope: envelope, EnvelopeDigest: digest, LeaseToken: response.LeaseToken, LeaseOwner: response.LeaseOwner, LeaseExpiresAt: leaseExpiresAt}, nil
}

func decodeJob(response recorderWorkerJobResponse) (recordingpipeline.Job, error) {
	jobID, err := utilities.ParseID(response.JobID)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response identity")}
	}
	tenantID, err := utilities.ParseID(response.TenantID)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response tenant")}
	}
	episodeID, err := utilities.ParseID(response.EpisodeID)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response episode")}
	}
	recordingID, err := utilities.ParseID(response.RecordingID)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response recording")}
	}
	if response.Kind != string(recordingpipeline.JobKindCapture) && response.Kind != string(recordingpipeline.JobKindRender) {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response kind")}
	}
	switch recordingpipeline.JobState(response.State) {
	case recordingpipeline.JobStatePending, recordingpipeline.JobStateLeased, recordingpipeline.JobStateSucceeded,
		recordingpipeline.JobStateRetryableFailure, recordingpipeline.JobStateTerminalFailure, recordingpipeline.JobStateCancelled:
	default:
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response state")}
	}
	if response.EnvelopeDigest != "" {
		if _, err := decodeHex(response.EnvelopeDigest, 32); err != nil {
			return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response digest")}
		}
	}
	availableAt, err := parseRequiredTime(response.AvailableAt)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response available time")}
	}
	updatedAt, err := parseRequiredTime(response.UpdatedAt)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response update time")}
	}
	createdAt, err := parseRequiredTime(response.CreatedAt)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response create time")}
	}
	job := recordingpipeline.Job{ID: jobID, TenantID: tenantID, EpisodeID: episodeID, RecordingID: recordingID, Kind: recordingpipeline.JobKind(response.Kind), State: recordingpipeline.JobState(response.State), AttemptCount: response.AttemptCount, AttemptLimit: response.AttemptLimit, FencingGeneration: response.FencingGeneration, CaptureEpoch: response.CaptureEpoch, AvailableAt: availableAt, UpdatedAt: updatedAt, CreatedAt: createdAt}
	if response.LeaseToken != "" {
		job.LeaseToken = stringPointer(response.LeaseToken)
	}
	if response.LeaseOwner != "" {
		job.LeaseOwner = stringPointer(response.LeaseOwner)
	}
	if response.LeaseExpiresAt != nil {
		value, err := parseRequiredTime(*response.LeaseExpiresAt)
		if err != nil {
			return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response lease expiry")}
		}
		job.LeaseExpiresAt = &value
	}
	if response.ErrorCode != "" {
		job.ErrorCode = stringPointer(response.ErrorCode)
	}
	if response.ErrorDetail != "" {
		job.ErrorDetail = stringPointer(response.ErrorDetail)
	}
	if response.TerminalAt != nil {
		value, err := parseRequiredTime(*response.TerminalAt)
		if err != nil {
			return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response terminal time")}
		}
		job.TerminalAt = &value
	}
	return job, nil
}

func verifyJobAuthority(job recordingpipeline.Job, input recordingpipeline.LeaseInput) error {
	if job.ID != input.JobID || job.AttemptCount != input.AttemptCount || job.FencingGeneration != input.FencingGeneration || job.CaptureEpoch != input.CaptureEpoch {
		return ProtocolError{Err: errors.New("job response authority mismatch")}
	}
	return nil
}

func decodeBundle(response recorderWorkerBundleResponse) (recordingpipeline.Bundle, error) {
	id, err := utilities.ParseID(response.ID)
	if err != nil {
		return recordingpipeline.Bundle{}, ProtocolError{Err: errors.New("bundle response id")}
	}
	tenantID, err := utilities.ParseID(response.TenantID)
	if err != nil {
		return recordingpipeline.Bundle{}, ProtocolError{Err: errors.New("bundle response tenant")}
	}
	recordingID, err := utilities.ParseID(response.RecordingID)
	if err != nil {
		return recordingpipeline.Bundle{}, ProtocolError{Err: errors.New("bundle response recording")}
	}
	captureJobID, err := utilities.ParseID(response.CaptureJobID)
	if err != nil {
		return recordingpipeline.Bundle{}, ProtocolError{Err: errors.New("bundle response capture job")}
	}
	checksum, err := decodeHex(response.Checksum, -1)
	if err != nil {
		return recordingpipeline.Bundle{}, ProtocolError{Err: errors.New("bundle response checksum")}
	}
	createdAt, err := parseRequiredTime(response.CreatedAt)
	if err != nil {
		return recordingpipeline.Bundle{}, ProtocolError{Err: errors.New("bundle response create time")}
	}
	return recordingpipeline.Bundle{ID: id, TenantID: tenantID, RecordingID: recordingID, CaptureJobID: captureJobID, SequenceNumber: response.SequenceNumber, FencingGeneration: response.FencingGeneration, ObjectKey: response.ObjectKey, ContentType: response.ContentType, Codec: response.Codec, Layer: response.Layer, ByteSize: response.ByteSize, Checksum: checksum, MonotonicStartMillis: response.MonotonicStartMillis, MonotonicEndMillis: response.MonotonicEndMillis, MediaStartMillis: response.MediaStartMillis, MediaEndMillis: response.MediaEndMillis, CreatedAt: createdAt}, nil
}

func verifyBundleAuthority(bundle recordingpipeline.Bundle, input recordingpipeline.BundleInput) error {
	if bundle.TenantID != input.TenantID || bundle.RecordingID != input.RecordingID || bundle.CaptureJobID != input.CaptureJobID || bundle.SequenceNumber != input.SequenceNumber || bundle.FencingGeneration != input.FencingGeneration {
		return ProtocolError{Err: errors.New("bundle response authority mismatch")}
	}
	return nil
}

func verifyPlanAuthority(plan captureplan.Plan, input captureplan.WaitInput) error {
	actual := plan.Authority()
	expected := input.Authority()
	if actual.PlanHandle != expected.PlanHandle || actual.TenantID != expected.TenantID || actual.SpaceID != expected.SpaceID || actual.EpisodeID != expected.EpisodeID || actual.RecordingID != expected.RecordingID || actual.JobID != expected.JobID || actual.AttemptCount != expected.AttemptCount || actual.FencingGeneration != expected.FencingGeneration || actual.CaptureEpoch != expected.CaptureEpoch || !bytes.Equal(actual.EnvelopeDigest, expected.EnvelopeDigest) {
		return ProtocolError{Err: errors.New("plan response authority mismatch")}
	}
	return nil
}

func (c *ControlPlaneClient) do(ctx context.Context, method, path string, payload any, responseLimit int) ([]byte, int, error) {
	if c == nil || c.client == nil || c.baseURL == nil {
		return nil, 0, ErrInvalidControlPlaneClient
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, ProtocolError{Err: err}
	}
	if len(body) > ControlPlaneRequestLimit {
		clear(body)
		return nil, 0, ErrControlPlaneProtocol
	}
	defer clear(body)
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	endpoint.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, 0, ProtocolError{Err: err}
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	if journeyID, ok := observability.JourneyIDFromContext(ctx); ok {
		request.Header.Set("X-Chalk-Journey-ID", journeyID.String())
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := c.client.Do(request)
	if err != nil {
		return nil, 0, TransportError{Err: err}
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, int64(responseLimit)))
		return nil, response.StatusCode, classifyHTTPError(response.StatusCode)
	}
	data, readErr := readBounded(response.Body, responseLimit)
	if readErr != nil {
		return nil, response.StatusCode, ProtocolError{Err: readErr}
	}
	return data, response.StatusCode, nil
}

func classifyHTTPError(status int) error {
	if status == http.StatusTooManyRequests || status >= http.StatusInternalServerError {
		return HTTPError{Status: status, Retryable: true}
	}
	if status == http.StatusConflict || status == http.StatusPreconditionFailed {
		return HTTPError{Status: status, Fenced: true}
	}
	return HTTPError{Status: status, Terminal: true}
}

func decodeBoundedJSON(data []byte, destination any, limit int) error {
	if len(data) > limit {
		return errors.New("response payload is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON")
		}
		return err
	}
	return nil
}

func readBounded(reader io.Reader, limit int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, errors.New("response payload is too large")
	}
	return data, nil
}

func durationSeconds(value time.Duration) (int, error) {
	if value == 0 {
		return 0, nil
	}
	if value < 0 || value%time.Second != 0 || value/time.Second > time.Duration(int(^uint(0)>>1)) {
		return 0, errors.New("duration must be a positive whole number of seconds")
	}
	return int(value / time.Second), nil
}

func decodeHex(value string, exactLength int) ([]byte, error) {
	decoded, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || (exactLength >= 0 && len(decoded) != exactLength) || len(decoded) > 1<<20 {
		return nil, errors.New("invalid hexadecimal value")
	}
	return decoded, nil
}

func parseRequiredTime(value string) (time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, errors.New("timestamp is absent")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}

func stringPointer(value string) *string { return &value }
