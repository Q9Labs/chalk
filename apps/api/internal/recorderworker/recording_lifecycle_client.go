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
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (c *ControlPlaneClient) ReportCaptureReady(ctx context.Context, event CaptureReadyEvent) error {
	authority, err := captureLifecycleAuthority(event.TenantID, event.SpaceID, event.EpisodeID, event.RecordingID, event.JobID, event.CaptureEpoch, event.Attempt, event.FencingGeneration, event.EnvelopeDigest, event.LeaseOwner, event.LeaseToken, event.LeaseExpiresAt)
	if err != nil || invalidCaptureLifecycleEvent(event.At, event.IdempotencyKey) {
		return ErrInvalidControlPlaneRequest
	}
	request := recorderprotocol.CaptureReadyRequest{CaptureLifecycleAuthority: authority, RequestKey: event.IdempotencyKey, ObservedAt: event.At.UTC().Format(time.RFC3339Nano), NoPublisher: event.NoPublisher}
	_, _, err = c.do(ctx, http.MethodPost, recorderprotocol.RouteCaptureReady.Path(), request, ControlPlaneResponseLimit)
	return err
}

func (c *ControlPlaneClient) ReportCaptureStopped(ctx context.Context, event CaptureStoppedEvent) error {
	authority, err := captureLifecycleAuthority(event.TenantID, event.SpaceID, event.EpisodeID, event.RecordingID, event.JobID, event.CaptureEpoch, event.Attempt, event.FencingGeneration, event.EnvelopeDigest, event.LeaseOwner, event.LeaseToken, event.LeaseExpiresAt)
	if err != nil || invalidCaptureLifecycleEvent(event.At, event.IdempotencyKey) {
		return ErrInvalidControlPlaneRequest
	}
	request := recorderprotocol.CaptureStoppedRequest{CaptureLifecycleAuthority: authority, RequestKey: event.IdempotencyKey, ObservedAt: event.At.UTC().Format(time.RFC3339Nano)}
	_, _, err = c.do(ctx, http.MethodPost, recorderprotocol.RouteCaptureStopped.Path(), request, ControlPlaneResponseLimit)
	return err
}

func captureLifecycleAuthority(tenantID, spaceID, episodeID, recordingID, jobID string, captureEpoch uint64, attempt int, fencingGeneration int64, envelopeDigest, leaseOwner, leaseToken string, leaseExpiresAt time.Time) (recorderprotocol.CaptureLifecycleAuthority, error) {
	for _, value := range []string{tenantID, spaceID, episodeID, recordingID, jobID} {
		if _, err := utilities.ParseID(value); err != nil {
			return recorderprotocol.CaptureLifecycleAuthority{}, err
		}
	}
	if captureEpoch == 0 || captureEpoch > math.MaxInt64 || attempt <= 0 || fencingGeneration <= 0 || strings.TrimSpace(leaseOwner) == "" || strings.TrimSpace(leaseToken) == "" || leaseExpiresAt.IsZero() {
		return recorderprotocol.CaptureLifecycleAuthority{}, errors.New("invalid capture lifecycle authority")
	}
	digest, err := decodeExactLowerHex(envelopeDigest)
	if err != nil {
		return recorderprotocol.CaptureLifecycleAuthority{}, err
	}
	return recorderprotocol.CaptureLifecycleAuthority{
		RecordingAuthority: recorderprotocol.RecordingAuthority{
			TenantID: tenantID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
			AttemptCount: attempt, FencingGeneration: fencingGeneration, CaptureEpoch: int64(captureEpoch),
			EnvelopeDigest: hex.EncodeToString(digest), LeaseToken: leaseToken, LeaseOwner: leaseOwner, LeaseExpiresAt: leaseExpiresAt.UTC().Format(time.RFC3339Nano),
		},
		SpaceID: spaceID,
	}, nil
}

func invalidCaptureLifecycleEvent(at time.Time, requestKey string) bool {
	key := strings.TrimSpace(requestKey)
	return at.IsZero() || key != requestKey || len(key) < 16 || len(key) > captureplane.MaxIdempotencyKeyBytes
}
