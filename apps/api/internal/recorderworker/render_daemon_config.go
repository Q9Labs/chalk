package recorderworker

import (
	"context"
	"errors"
	"time"
)

const (
	DefaultRenderLease       = 30 * time.Minute
	defaultRenderFailureCode = "render_attempt_failed"
)

var (
	ErrInvalidRenderDaemon    = errors.New("invalid recorder render daemon")
	ErrRenderDaemonStopped    = errors.New("recorder render daemon stopped")
	ErrRenderAttemptCommitted = errors.New("recording render attempt already committed")
)

type RenderDaemonConfig struct {
	Lease             time.Duration
	HeartbeatInterval time.Duration
	NoWorkWait        time.Duration
	ClaimRetryWait    time.Duration
	AttemptRetryDelay time.Duration
	Wait              func(context.Context, time.Duration) error
	After             func(time.Duration) <-chan time.Time
	Now               func() time.Time
}

func normalizeRenderDaemonConfig(config RenderDaemonConfig) RenderDaemonConfig {
	if config.Lease == 0 {
		config.Lease = DefaultRenderLease
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
		config.AttemptRetryDelay = DefaultAttemptRetryDelay
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
