package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// CaptureControlPlane is the fenced job lifecycle needed by the capture
// daemon. Media signaling and object persistence stay inside CaptureAttempt.
type CaptureControlPlane interface {
	ClaimJob(context.Context, utilities.ID, time.Duration) (ClaimResult, error)
	Heartbeat(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	RelinquishCapture(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
	Fail(context.Context, recordingpipeline.FailureInput) (recordingpipeline.Job, error)
	Complete(context.Context, recordingpipeline.LeaseInput) (recordingpipeline.Job, error)
}

// CaptureAttempt owns one server-issued capture epoch. Implementations must
// never replace their peer connection or increment the epoch locally. Close is
// called after Run returns and must finish cleanup once or replay its result
// without starting a second close.
type CaptureAttempt interface {
	Run(context.Context) error
	RenewLease(capturesignaling.WorkerLease) error
	Close(context.Context) error
}

type CaptureAttemptFactory interface {
	NewCaptureAttempt(context.Context, ClaimResult) (CaptureAttempt, error)
}

type CaptureDaemon struct {
	control         CaptureControlPlane
	factory         CaptureAttemptFactory
	config          CaptureDaemonConfig
	running         atomic.Bool
	retired         atomic.Int32
	draining        atomic.Bool
	drain           chan struct{}
	admissionClosed atomic.Bool
	admissionStop   chan struct{}
}

func NewCaptureDaemon(control CaptureControlPlane, factory CaptureAttemptFactory, config CaptureDaemonConfig) (*CaptureDaemon, error) {
	if control == nil || factory == nil {
		return nil, ErrInvalidCaptureDaemon
	}
	config = normalizeCaptureDaemonConfig(config)
	if config.Slots < 1 || config.Lease <= 0 || config.HeartbeatInterval <= 0 || config.HeartbeatInterval >= config.Lease || config.NoWorkWait <= 0 || config.ClaimRetryWait <= 0 || config.AttemptRetryDelay < 0 || config.AttemptShutdown <= 0 || config.HandoffShutdown <= 0 || config.RelinquishTimeout <= 0 || config.CompletionTimeout <= 0 || config.Wait == nil || config.After == nil || config.Now == nil ||
		config.RelinquishTimeout >= ReadinessShutdownGrace {
		return nil, ErrInvalidCaptureDaemon
	}
	minimumLeaseWindow := config.Lease - config.HeartbeatInterval
	if config.RelinquishTimeout >= minimumLeaseWindow || config.HandoffShutdown >= minimumLeaseWindow-config.RelinquishTimeout ||
		config.HandoffShutdown >= ReadinessShutdownGrace-config.RelinquishTimeout {
		return nil, ErrInvalidCaptureDaemon
	}
	return &CaptureDaemon{control: control, factory: factory, config: config, drain: make(chan struct{}), admissionStop: make(chan struct{})}, nil
}

func (d *CaptureDaemon) Run(ctx context.Context) error {
	if d == nil || d.control == nil || d.factory == nil {
		return ErrInvalidCaptureDaemon
	}
	if !d.running.CompareAndSwap(false, true) {
		return ErrInvalidCaptureDaemon
	}
	defer d.running.Store(false)
	if d.admissionClosed.Load() {
		return ErrWorkerDraining
	}
	claimCtx, cancelClaims := context.WithCancel(ctx)
	defer cancelClaims()
	go func() {
		select {
		case <-d.admissionStop:
			cancelClaims()
		case <-claimCtx.Done():
		}
	}()
	if d.config.Slots == 1 {
		return d.runLoop(ctx, claimCtx)
	}
	capacity := d.ReadyCapacity()
	if capacity == 0 {
		return errCaptureSlotRetired
	}
	var slots sync.WaitGroup
	allRetired := make(chan struct{})
	results := make(chan error, capacity)
	for range capacity {
		slots.Go(func() {
			for ctx.Err() == nil && !d.admissionClosed.Load() {
				err := captureOperation(func() error { return d.runLoop(ctx, claimCtx) })
				if ctx.Err() != nil || d.admissionClosed.Load() {
					results <- err
					return
				}
				if errors.Is(err, errCaptureSlotRetired) {
					slog.ErrorContext(ctx, "recorder capture slot retired after cleanup failure", "error", err)
					if d.retired.Add(1) == int32(d.config.Slots) {
						close(allRetired)
					}
					select {
					case <-ctx.Done():
					case <-d.admissionStop:
					case <-allRetired:
					}
					results <- err
					return
				}
				slog.ErrorContext(ctx, "recorder capture slot restarting", "error", err)
				// Retain the slot until any lost claim or last renewed lease expires.
				timer := time.NewTimer(d.config.Lease)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-d.admissionStop:
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		})
	}
	slots.Wait()
	close(results)
	var result error
	for err := range results {
		result = errors.Join(result, err)
	}
	if ctx.Err() != nil {
		return errors.Join(ErrCaptureDaemonStopped, ctx.Err(), result)
	}
	if d.admissionClosed.Load() {
		return errors.Join(ErrWorkerDraining, result)
	}
	return result
}

// ReadyCapacity includes busy slots, but never slots with failed cleanup.
func (d *CaptureDaemon) ReadyCapacity() int {
	if d.admissionClosed.Load() {
		return 0
	}
	return d.config.Slots - int(d.retired.Load())
}

func captureOperation(operation func() error) (err error) {
	defer func() {
		if recover() != nil {
			err = capturePanicError()
		}
	}()
	return operation()
}

// Keep the source location without logging arbitrary panic values, which may
// contain credentials or media. Bound the stack so recovery cannot flood logs.
func capturePanicError() error {
	stack := debug.Stack()
	slog.Error("recorder capture operation panicked", "stack", string(stack[:min(len(stack), 16*1024)]))
	return errors.New("recorder capture operation panicked")
}

func (d *CaptureDaemon) runLoop(ctx, claimCtx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return errors.Join(ErrCaptureDaemonStopped, err)
		}
		if d.admissionClosed.Load() {
			return ErrWorkerDraining
		}
		claimRequestID, err := utilities.NewID()
		if err != nil {
			return fmt.Errorf("create recorder claim request id: %w", err)
		}
		claim, err := d.claimJob(claimCtx, claimRequestID)
		if err != nil {
			if errors.Is(err, ErrWorkerDraining) || d.admissionClosed.Load() {
				d.CloseAdmission()
				return ErrWorkerDraining
			}
			if errors.Is(err, ErrNoWork) {
				if waitErr := d.config.Wait(claimCtx, d.config.NoWorkWait); waitErr != nil {
					if d.admissionClosed.Load() {
						return ErrWorkerDraining
					}
					return errors.Join(ErrCaptureDaemonStopped, waitErr)
				}
				continue
			}
			return fmt.Errorf("claim recorder capture job: %w", err)
		}

		if err := d.runClaim(ctx, claim); err != nil {
			return err
		}
	}
}

// CloseAdmission stops claim and restart loops without interrupting held work.
func (d *CaptureDaemon) CloseAdmission() {
	if d != nil && d.admissionClosed.CompareAndSwap(false, true) {
		close(d.admissionStop)
	}
}

// Drain closes admission and hands an active capture back through its current
// fence so another worker can continue with fresh attempt authority.
func (d *CaptureDaemon) Drain() {
	d.CloseAdmission()
	if d != nil && d.draining.CompareAndSwap(false, true) {
		close(d.drain)
	}
}

func waitForCaptureDaemon(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

var _ CaptureControlPlane = (*ControlPlaneClient)(nil)
