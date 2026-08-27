package recorderworker

import (
	"context"
	"encoding/hex"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recorderCaptureLifecycleAuthorityRequest struct {
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
	LeaseOwner        string `json:"lease_owner"`
	LeaseExpiresAt    string `json:"lease_expires_at"`
}

type recorderCaptureReadyRequest struct {
	recorderCaptureLifecycleAuthorityRequest
	RequestKey  string `json:"request_key"`
	ObservedAt  string `json:"observed_at"`
	NoPublisher bool   `json:"no_publisher"`
}

type recorderCaptureStoppedRequest struct {
	recorderCaptureLifecycleAuthorityRequest
	RequestKey string `json:"request_key"`
	ObservedAt string `json:"observed_at"`
}

func (c *ControlPlaneClient) ReportCaptureReady(ctx context.Context, event CaptureReadyEvent) error {
	authority, err := captureLifecycleAuthority(event.TenantID, event.SpaceID, event.EpisodeID, event.RecordingID, event.JobID, event.CaptureEpoch, event.Attempt, event.FencingGeneration, event.EnvelopeDigest, event.LeaseOwner, event.LeaseToken, event.LeaseExpiresAt)
	if err != nil || invalidCaptureLifecycleEvent(event.At, event.IdempotencyKey) {
		return ErrInvalidControlPlaneRequest
	}
	request := recorderCaptureReadyRequest{recorderCaptureLifecycleAuthorityRequest: authority, RequestKey: event.IdempotencyKey, ObservedAt: event.At.UTC().Format(time.RFC3339Nano), NoPublisher: event.NoPublisher}
	_, _, err = c.do(ctx, http.MethodPost, "/internal/v1/recorder/capture/ready", request, ControlPlaneResponseLimit)
	return err
}

func (c *ControlPlaneClient) ReportCaptureStopped(ctx context.Context, event CaptureStoppedEvent) error {
	authority, err := captureLifecycleAuthority(event.TenantID, event.SpaceID, event.EpisodeID, event.RecordingID, event.JobID, event.CaptureEpoch, event.Attempt, event.FencingGeneration, event.EnvelopeDigest, event.LeaseOwner, event.LeaseToken, event.LeaseExpiresAt)
	if err != nil || invalidCaptureLifecycleEvent(event.At, event.IdempotencyKey) {
		return ErrInvalidControlPlaneRequest
	}
	request := recorderCaptureStoppedRequest{recorderCaptureLifecycleAuthorityRequest: authority, RequestKey: event.IdempotencyKey, ObservedAt: event.At.UTC().Format(time.RFC3339Nano)}
	_, _, err = c.do(ctx, http.MethodPost, "/internal/v1/recorder/capture/stopped", request, ControlPlaneResponseLimit)
	return err
}

func captureLifecycleAuthority(tenantID, spaceID, episodeID, recordingID, jobID string, captureEpoch uint64, attempt int, fencingGeneration int64, envelopeDigest, leaseOwner, leaseToken string, leaseExpiresAt time.Time) (recorderCaptureLifecycleAuthorityRequest, error) {
	for _, value := range []string{tenantID, spaceID, episodeID, recordingID, jobID} {
		if _, err := utilities.ParseID(value); err != nil {
			return recorderCaptureLifecycleAuthorityRequest{}, err
		}
	}
	if captureEpoch == 0 || captureEpoch > math.MaxInt64 || attempt <= 0 || fencingGeneration <= 0 || strings.TrimSpace(leaseOwner) == "" || strings.TrimSpace(leaseToken) == "" || leaseExpiresAt.IsZero() {
		return recorderCaptureLifecycleAuthorityRequest{}, errors.New("invalid capture lifecycle authority")
	}
	digest, err := decodeExactLowerHex(envelopeDigest)
	if err != nil {
		return recorderCaptureLifecycleAuthorityRequest{}, err
	}
	return recorderCaptureLifecycleAuthorityRequest{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		AttemptCount: attempt, FencingGeneration: fencingGeneration, CaptureEpoch: int64(captureEpoch),
		EnvelopeDigest: hex.EncodeToString(digest), LeaseToken: leaseToken, LeaseOwner: leaseOwner, LeaseExpiresAt: leaseExpiresAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func invalidCaptureLifecycleEvent(at time.Time, requestKey string) bool {
	key := strings.TrimSpace(requestKey)
	return at.IsZero() || key != requestKey || len(key) < 16 || len(key) > captureplane.MaxIdempotencyKeyBytes
}
