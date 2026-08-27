package captureplan

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Repository is the persistence boundary for desired-state plan snapshots.
// Reconcile must return ErrNoChange when no plan revision is newer than the
// requested cursor and must not hold a transaction while the caller waits.
type Repository interface {
	Reconcile(context.Context, WaitInput) (Plan, error)
}

// WorkerLease carries the lease fence that remains valid for the wait.
type WorkerLease struct {
	Owner     string
	Token     string
	ExpiresAt time.Time
}

// WaitInput is the complete worker authority fence plus the revision cursor
// from which the worker wants a newer plan.
type WaitInput struct {
	PlanHandle        PlanHandle
	TenantID          utilities.ID
	SpaceID           utilities.ID
	EpisodeID         utilities.ID
	RecordingID       utilities.ID
	JobID             utilities.ID
	AttemptCount      int
	FencingGeneration int64
	CaptureEpoch      captureplane.CaptureEpoch
	EnvelopeDigest    []byte
	LeaseOwner        string
	LeaseToken        string
	LeaseExpiresAt    time.Time
	AfterRevision     captureplane.PlanRevision
	MaxWait           time.Duration
}

// NewWaitInput builds the flat transport-facing form from an authority and a
// lease. It copies the digest so callers can safely reuse their request bytes.
func NewWaitInput(authority PlanAuthority, lease WorkerLease, afterRevision captureplane.PlanRevision, maxWait time.Duration) WaitInput {
	return WaitInput{
		PlanHandle: authority.PlanHandle, TenantID: authority.TenantID, SpaceID: authority.SpaceID,
		EpisodeID: authority.EpisodeID, RecordingID: authority.RecordingID, JobID: authority.JobID,
		AttemptCount: authority.AttemptCount, FencingGeneration: authority.FencingGeneration,
		CaptureEpoch: authority.CaptureEpoch, EnvelopeDigest: append([]byte(nil), authority.EnvelopeDigest...),
		LeaseOwner: lease.Owner, LeaseToken: lease.Token, LeaseExpiresAt: lease.ExpiresAt,
		AfterRevision: afterRevision, MaxWait: maxWait,
	}
}

func (input WaitInput) Authority() PlanAuthority {
	return PlanAuthority{
		PlanHandle: input.PlanHandle, TenantID: input.TenantID, SpaceID: input.SpaceID,
		EpisodeID: input.EpisodeID, RecordingID: input.RecordingID, JobID: input.JobID,
		AttemptCount: input.AttemptCount, FencingGeneration: input.FencingGeneration,
		CaptureEpoch: input.CaptureEpoch, EnvelopeDigest: append([]byte(nil), input.EnvelopeDigest...),
	}
}

func (input WaitInput) Lease() WorkerLease {
	return WorkerLease{Owner: input.LeaseOwner, Token: input.LeaseToken, ExpiresAt: input.LeaseExpiresAt}
}

func (input WaitInput) Validate(now time.Time) error {
	if err := validateAuthority(input.Authority()); err != nil {
		return errors.Join(ErrInvalidWaitInput, err)
	}
	if input.MaxWait < MinimumWait || input.MaxWait > MaximumWait {
		return errors.Join(ErrInvalidWaitInput, errors.New("max wait is outside the bounded wait range"))
	}
	if !validOpaque(input.LeaseOwner, MaximumLeaseOwner) || !validOpaque(input.LeaseToken, MaximumLeaseToken) {
		return errors.Join(ErrInvalidWaitInput, errors.New("lease owner and token are required"))
	}
	if input.LeaseExpiresAt.IsZero() {
		return errors.Join(ErrInvalidWaitInput, errors.New("lease expiry is required"))
	}
	if !now.Before(input.LeaseExpiresAt) {
		return ErrLeaseExpired
	}
	return nil
}

// Clock and WaitFunc make waiting deterministic in tests and permit callers
// to integrate a scheduler without embedding time.Sleep in the domain.
type Clock func() time.Time
type WaitFunc func(context.Context, time.Duration) error

// Config controls the service's polling behavior. Zero values select bounded
// production defaults.
type Config struct {
	Now          Clock
	Wait         WaitFunc
	PollInterval time.Duration
}

// Service validates worker authority and coordinates bounded polling against
// a Repository. It contains no database transaction or provider state.
type Service struct {
	repository   Repository
	now          Clock
	wait         WaitFunc
	pollInterval time.Duration
}

func NewService(repository Repository) Service {
	return NewServiceWithConfig(repository, Config{})
}

func NewServiceWithConfig(repository Repository, config Config) Service {
	now := config.Now
	if now == nil {
		now = time.Now
	}
	wait := config.Wait
	if wait == nil {
		wait = waitFor
	}
	pollInterval := config.PollInterval
	if pollInterval <= 0 {
		pollInterval = DefaultPollInterval
	}
	if pollInterval > MaximumWait {
		pollInterval = MaximumWait
	}
	return Service{repository: repository, now: now, wait: wait, pollInterval: pollInterval}
}

func (s Service) WithClock(now Clock) Service {
	if now != nil {
		s.now = now
	}
	return s
}

func (s Service) WithWait(wait WaitFunc) Service {
	if wait != nil {
		s.wait = wait
	}
	return s
}

func (s Service) WithPollInterval(interval time.Duration) Service {
	if interval > 0 {
		if interval > MaximumWait {
			interval = MaximumWait
		}
		s.pollInterval = interval
	}
	return s
}

// Wait first performs a reconcile and returns a newer plan immediately. On
// ErrNoChange it polls until MaxWait, the lease expires, or the context ends.
func (s Service) Wait(ctx context.Context, input WaitInput) (Plan, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.repository == nil {
		return Plan{}, ErrRepositoryUnavailable
	}
	now := s.nowUTC()
	if err := input.Validate(now); err != nil {
		return Plan{}, err
	}
	deadline := now.Add(input.MaxWait)
	if input.LeaseExpiresAt.Before(deadline) {
		deadline = input.LeaseExpiresAt
	}

	for {
		if err := ctx.Err(); err != nil {
			return Plan{}, err
		}
		plan, err := s.repository.Reconcile(ctx, input)
		if err == nil {
			if err := plan.Validate(); err != nil {
				return Plan{}, err
			}
			if !planMatchesWaitInput(plan, input) {
				return Plan{}, ErrPlanAuthorityMismatch
			}
			if plan.Revision() <= input.AfterRevision {
				return Plan{}, ErrStalePlan
			}
			return plan, nil
		}
		if !errors.Is(err, ErrNoChange) {
			return Plan{}, err
		}

		now = s.nowUTC()
		if !now.Before(input.LeaseExpiresAt) {
			return Plan{}, ErrLeaseExpired
		}
		if !now.Before(deadline) {
			return Plan{}, ErrWaitTimeout
		}
		waitDuration := s.pollInterval
		remaining := deadline.Sub(now)
		if waitDuration <= 0 || waitDuration > remaining {
			waitDuration = remaining
		}
		if err := s.wait(ctx, waitDuration); err != nil {
			return Plan{}, err
		}
	}
}

func (s Service) nowUTC() time.Time {
	now := s.now()
	if now.IsZero() {
		now = time.Now()
	}
	return now.UTC()
}

func planMatchesWaitInput(plan Plan, input WaitInput) bool {
	authority := plan.Authority()
	if authority.PlanHandle != input.PlanHandle || authority.TenantID != input.TenantID || authority.SpaceID != input.SpaceID || authority.EpisodeID != input.EpisodeID || authority.RecordingID != input.RecordingID || authority.JobID != input.JobID || authority.AttemptCount != input.AttemptCount || authority.FencingGeneration != input.FencingGeneration || authority.CaptureEpoch != input.CaptureEpoch {
		return false
	}
	return bytesEqual(authority.EnvelopeDigest, input.EnvelopeDigest)
}

func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func waitFor(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
