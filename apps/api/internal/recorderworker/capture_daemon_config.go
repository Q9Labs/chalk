package recorderworker

import (
	"context"
	"errors"
	"time"
)

const (
	DefaultCaptureLease             = 30 * time.Second
	DefaultHeartbeatInterval        = 10 * time.Second
	DefaultAttemptShutdown          = 3 * defaultCaptureCloseTimeout
	DefaultHandoffShutdown          = 16 * time.Second
	DefaultRelinquishTimeout        = 3 * time.Second
	DefaultNoWorkWait               = 2 * time.Second
	DefaultClaimRetryWait           = time.Second
	DefaultAttemptRetryDelay        = 5 * time.Second
	DefaultCaptureAttemptRetryDelay = 30 * time.Second
	DefaultCaptureCompletion        = 5 * time.Minute
	DefaultCompletionRetry          = 2 * time.Minute
	defaultCaptureFailureCode       = "capture_attempt_failed"
	completionFailureCode           = "capture_completion_failed"
)

var (
	ErrInvalidCaptureDaemon   = errors.New("invalid recorder capture daemon")
	ErrCaptureDaemonStopped   = errors.New("recorder capture daemon stopped")
	ErrCaptureAttemptShutdown = errors.New("recorder capture attempt did not shut down within its bound")
	errCaptureSlotRetired     = errors.New("recorder capture slot cleanup failed")
	ErrCaptureHandoffWindow   = errors.New("recorder capture lease has insufficient handoff time")
)

// CaptureDaemonConfig controls the process-wide slot limit. Ports supplied to
// NewCaptureDaemon must support concurrent calls when Slots exceeds one.
type CaptureDaemonConfig struct {
	Slots             int
	Lease             time.Duration
	HeartbeatInterval time.Duration
	NoWorkWait        time.Duration
	ClaimRetryWait    time.Duration
	AttemptRetryDelay time.Duration
	AttemptShutdown   time.Duration
	HandoffShutdown   time.Duration
	RelinquishTimeout time.Duration
	CompletionTimeout time.Duration
	Wait              func(context.Context, time.Duration) error
	After             func(time.Duration) <-chan time.Time
	Now               func() time.Time
}

func normalizeCaptureDaemonConfig(config CaptureDaemonConfig) CaptureDaemonConfig {
	if config.Slots == 0 {
		config.Slots = 1
	}
	if config.Lease == 0 {
		config.Lease = DefaultCaptureLease
	}
	if config.HeartbeatInterval == 0 {
		config.HeartbeatInterval = DefaultHeartbeatInterval
	}
	if config.NoWorkWait == 0 {
		config.NoWorkWait = DefaultNoWorkWait
	}
	if config.ClaimRetryWait == 0 {
		config.ClaimRetryWait = DefaultClaimRetryWait
	}
	if config.AttemptRetryDelay == 0 {
		config.AttemptRetryDelay = DefaultCaptureAttemptRetryDelay
	}
	if config.AttemptShutdown == 0 {
		config.AttemptShutdown = DefaultAttemptShutdown
	}
	if config.HandoffShutdown == 0 {
		config.HandoffShutdown = DefaultHandoffShutdown
	}
	if config.RelinquishTimeout == 0 {
		config.RelinquishTimeout = DefaultRelinquishTimeout
	}
	if config.CompletionTimeout == 0 {
		config.CompletionTimeout = DefaultCaptureCompletion
	}
	if config.Wait == nil {
		config.Wait = waitForCaptureDaemon
	}
	if config.After == nil {
		config.After = time.After
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return config
}
