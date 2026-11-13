package recorderworker

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	ControlPlaneRequestLimit  = 2 << 20
	ControlPlaneResponseLimit = 2 << 20
)

// ControlPlaneClient is the private recorder worker client. The HTTP client
// is supplied by the caller so mTLS and its transport policy remain outside
// this package.
type ControlPlaneClient struct {
	baseURL  *url.URL
	client   *http.Client
	uploader *http.Client
}

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

func (c *ControlPlaneClient) Claim(ctx context.Context, input recordingpipeline.ClaimInput) (ClaimResult, error) {
	leaseSeconds, err := durationSeconds(input.LeaseFor)
	if err != nil || input.ClaimRequestID.IsZero() {
		return ClaimResult{}, fmt.Errorf("%w: claim input", ErrInvalidControlPlaneRequest)
	}
	payload := recorderprotocol.ClaimRequest{ClaimRequestID: input.ClaimRequestID.String(), LeaseForSeconds: leaseSeconds, SupportsCompletionOnly: true}
	body, status, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteJobsClaim.Path(), payload, ControlPlaneResponseLimit)
	var httpErr HTTPError
	if errors.As(err, &httpErr) && httpErr.Status == http.StatusBadRequest {
		// Older APIs reject the new field; the same claim may still take
		// ordinary Capture work, but cannot receive completion-only work.
		payload.SupportsCompletionOnly = false
		body, status, err = c.do(ctx, http.MethodPost, recorderprotocol.RouteJobsClaim.Path(), payload, ControlPlaneResponseLimit)
	}
	if errors.As(err, &httpErr) && httpErr.Status == http.StatusLocked && httpErr.Code == recorderprotocol.CodeWorkerAdmissionClosed {
		return ClaimResult{}, ErrWorkerDraining
	}
	if err != nil {
		return ClaimResult{}, err
	}
	if status == http.StatusNoContent {
		return ClaimResult{}, NoWorkError{}
	}
	var response recorderprotocol.ClaimResponse
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
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteJobsHeartbeat.Path(), payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	var response recorderprotocol.JobResponse
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
	payload := recorderprotocol.ProgressRequest{LeaseRequest: lease, Stage: input.Stage, Completed: input.Completed, Total: input.Total, Bytes: input.Bytes, ObjectKey: input.ObjectKey}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteJobsProgress.Path(), payload, ControlPlaneResponseLimit)
	if err != nil {
		return ProgressResult{}, err
	}
	var response recorderprotocol.ProgressResponse
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
	payload := recorderprotocol.FailRequest{LeaseRequest: lease, ErrorCode: input.ErrorCode, ErrorDetail: input.ErrorDetail}
	if !input.AvailableAt.IsZero() {
		payload.AvailableAt = input.AvailableAt.UTC().Format(time.RFC3339Nano)
	}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteJobsFail.Path(), payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	var response recorderprotocol.JobResponse
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

func (c *ControlPlaneClient) RelinquishCapture(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	payload, err := leaseRequest(input)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteJobsRelinquish.Path(), payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	var response recorderprotocol.JobResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: err}
	}
	job, err := decodeJob(response)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	if job.ID != input.JobID || job.Kind != recordingpipeline.JobKindCapture || job.State != recordingpipeline.JobStatePending || job.AttemptCount != input.AttemptCount-1 || job.FencingGeneration != input.FencingGeneration || job.CaptureEpoch != input.CaptureEpoch || job.LeaseToken != nil || job.LeaseOwner != nil || job.LeaseExpiresAt != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("capture relinquish response authority mismatch")}
	}
	return job, nil
}

func (c *ControlPlaneClient) Complete(ctx context.Context, input recordingpipeline.LeaseInput) (recordingpipeline.Job, error) {
	payload, err := leaseRequest(input)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	body, _, err := c.do(ctx, http.MethodPost, recorderprotocol.RouteJobsComplete.Path(), payload, ControlPlaneResponseLimit)
	if err != nil {
		return recordingpipeline.Job{}, err
	}
	var response recorderprotocol.JobResponse
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

func (c *ControlPlaneClient) WaitForPlan(ctx context.Context, input captureplan.WaitInput) (captureplan.Plan, error) {
	if err := input.Validate(time.Now().UTC()); err != nil {
		return captureplan.Plan{}, fmt.Errorf("%w: plan wait: %v", ErrInvalidControlPlaneRequest, err)
	}
	payload := recorderprotocol.CapturePlanWaitRequest{
		PlanHandle: string(input.PlanHandle), TenantID: input.TenantID.String(), SpaceID: input.SpaceID.String(),
		EpisodeID: input.EpisodeID.String(), RecordingID: input.RecordingID.String(), JobID: input.JobID.String(),
		AttemptCount: input.AttemptCount, FencingGeneration: input.FencingGeneration,
		CaptureEpoch: int64(input.CaptureEpoch), EnvelopeDigest: hex.EncodeToString(input.EnvelopeDigest),
		LeaseToken: input.LeaseToken, LeaseExpiresAt: input.LeaseExpiresAt.UTC().Format(time.RFC3339Nano),
		AfterRevision: int64(input.AfterRevision), WaitMilliseconds: input.MaxWait.Milliseconds(),
	}
	body, status, err := c.do(ctx, http.MethodPost, recorderprotocol.RoutePlansWait.Path(), payload, ControlPlaneResponseLimit)
	if err != nil {
		return captureplan.Plan{}, err
	}
	if status == http.StatusNoContent {
		return captureplan.Plan{}, NoChangeError{}
	}
	var response recorderprotocol.CapturePlanResponse
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
