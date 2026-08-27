package recordinglifecycle

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrInvalidRequest        = errors.New("invalid recording capture lifecycle request")
	ErrAuthorityMismatch     = errors.New("recording capture lifecycle authority mismatch")
	ErrRecordingNotFound     = errors.New("recording capture lifecycle recording not found")
	ErrOperationConflict     = errors.New("recording capture lifecycle operation conflict")
	ErrRepositoryUnavailable = errors.New("recording capture lifecycle repository unavailable")
)

var requestKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// Authority is the complete worker authority tuple. The repository repeats
// every value against the live capture lease in the same transaction.
type Authority struct {
	TenantID          string
	SpaceID           string
	EpisodeID         string
	RecordingID       string
	JobID             string
	AttemptCount      int
	FencingGeneration int64
	CaptureEpoch      int64
	EnvelopeDigest    []byte
	LeaseOwner        string
	LeaseToken        string
	LeaseExpiresAt    time.Time
}

type ReadyInput struct {
	Authority
	RequestKey  string
	ReadyAt     time.Time
	NoPublisher bool
}

type StoppedInput struct {
	Authority
	RequestKey string
	StoppedAt  time.Time
}

type Publication struct {
	ExternalOperationID string
	OperationName       string
	RequestKey          string
	RequestFingerprint  []byte
	Payload             []byte
}

type Repository interface {
	PublishReady(ctx context.Context, input ReadyInput) (Publication, error)
	PublishStopped(ctx context.Context, input StoppedInput) (Publication, error)
}

func (a Authority) Validate(now time.Time) error {
	for name, value := range map[string]string{
		"tenant_id":    a.TenantID,
		"space_id":     a.SpaceID,
		"episode_id":   a.EpisodeID,
		"recording_id": a.RecordingID,
		"job_id":       a.JobID,
	} {
		if _, err := utilities.ParseID(value); err != nil {
			return fmt.Errorf("%w: %s", ErrInvalidRequest, name)
		}
	}
	if a.AttemptCount <= 0 || a.FencingGeneration <= 0 || a.CaptureEpoch <= 0 || len(a.EnvelopeDigest) != sha256.Size {
		return ErrInvalidRequest
	}
	if strings.TrimSpace(a.LeaseOwner) == "" || strings.TrimSpace(a.LeaseToken) == "" || a.LeaseExpiresAt.IsZero() || !a.LeaseExpiresAt.After(now.UTC()) {
		return ErrInvalidRequest
	}
	return nil
}

func validateRequestKey(value string) error {
	if !requestKeyPattern.MatchString(value) {
		return ErrInvalidRequest
	}
	return nil
}

func validateReadyInput(input ReadyInput, now time.Time) error {
	if err := input.Authority.Validate(now); err != nil {
		return err
	}
	if err := validateRequestKey(input.RequestKey); err != nil {
		return err
	}
	if input.ReadyAt.IsZero() {
		return ErrInvalidRequest
	}
	return nil
}

func validateStoppedInput(input StoppedInput, now time.Time) error {
	if err := input.Authority.Validate(now); err != nil {
		return err
	}
	if err := validateRequestKey(input.RequestKey); err != nil {
		return err
	}
	if input.StoppedAt.IsZero() {
		return ErrInvalidRequest
	}
	return nil
}
