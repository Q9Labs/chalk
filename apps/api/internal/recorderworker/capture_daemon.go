package recorderworker

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel/trace"
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

func (d *CaptureDaemon) claimJob(ctx context.Context, claimRequestID utilities.ID) (ClaimResult, error) {
	for {
		if d.admissionClosed.Load() {
			return ClaimResult{}, ErrWorkerDraining
		}
		claim, err := d.control.ClaimJob(ctx, claimRequestID, d.config.Lease)
		if err == nil || !errors.Is(err, ErrControlPlaneRetryable) {
			return claim, err
		}
		if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
			return ClaimResult{}, errors.Join(ErrCaptureDaemonStopped, waitErr)
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

func (d *CaptureDaemon) runClaim(ctx context.Context, claim ClaimResult) (err error) {
	ctx, err = captureAttemptContext(ctx, claim)
	if err != nil {
		return err
	}
	lease, err := captureLeaseInput(claim, d.config.Lease)
	if err != nil {
		return err
	}
	if claim.Envelope.CompletionOnly {
		if err := d.completeCapture(ctx, lease, claim.LeaseExpiresAt.UTC(), true); err != nil {
			return d.reportCompletionFailure(ctx, lease, err)
		}
		return nil
	}
	attempt, err := d.factory.NewCaptureAttempt(ctx, claim)
	if err != nil {
		return d.reportAttemptFailure(ctx, lease, err)
	}

	attemptCtx, cancelAttempt := context.WithCancel(ctx)
	defer cancelAttempt()
	leaseExpiresAt := claim.LeaseExpiresAt.UTC()
	result := make(chan error, 1)
	go func() {
		// Cleanup recovery may observe completion again after the first result
		// was consumed (for example, when relinquishing the lease panics).
		defer close(result)
		result <- captureOperation(func() error { return attempt.Run(attemptCtx) })
	}()

	defer func() {
		if recover() != nil {
			_, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.AttemptShutdown)
			err = errors.Join(capturePanicError(), closeErr, shutdownErr)
		}
	}()
	for {
		select {
		case runErr := <-result:
			return d.finishCaptureAttempt(ctx, attempt, cancelAttempt, result, runErr, lease, leaseExpiresAt)
		case <-d.drain:
			select {
			case runErr := <-result:
				return d.finishCaptureAttempt(ctx, attempt, cancelAttempt, result, runErr, lease, leaseExpiresAt)
			default:
			}
			return d.interruptCaptureAttempt(ctx, attempt, cancelAttempt, result, lease, leaseExpiresAt, ErrWorkerDraining)
		case <-ctx.Done():
			return d.interruptCaptureAttempt(ctx, attempt, cancelAttempt, result, lease, leaseExpiresAt, errors.Join(ErrCaptureDaemonStopped, ctx.Err()))
		case <-d.config.After(d.config.HeartbeatInterval):
			job, heartbeatErr := d.heartbeat(ctx, lease, leaseExpiresAt)
			if heartbeatErr != nil {
				if ctx.Err() != nil {
					return d.interruptCaptureAttempt(ctx, attempt, cancelAttempt, result, lease, leaseExpiresAt, errors.Join(ErrCaptureDaemonStopped, ctx.Err()))
				}
				runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.AttemptShutdown)
				return fmt.Errorf("renew recorder capture lease: %w", errors.Join(heartbeatErr, runErr, closeErr, shutdownErr))
			}
			renewed, renewErr := renewedCaptureLease(lease, job, d.config.Lease, d.config.Now().UTC())
			if renewErr != nil {
				runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.AttemptShutdown)
				return errors.Join(renewErr, runErr, closeErr, shutdownErr)
			}
			if renewErr = attempt.RenewLease(capturesignaling.WorkerLease{Owner: renewed.LeaseOwner, Token: renewed.LeaseToken, ExpiresAt: job.LeaseExpiresAt.UTC()}); renewErr != nil {
				runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.AttemptShutdown)
				return fmt.Errorf("apply recorder capture lease: %w", errors.Join(renewErr, runErr, closeErr, shutdownErr))
			}
			lease = renewed
			leaseExpiresAt = job.LeaseExpiresAt.UTC()
		}
	}
}

func (d *CaptureDaemon) finishCaptureAttempt(ctx context.Context, attempt CaptureAttempt, cancelAttempt context.CancelFunc, result <-chan error, runErr error, lease recordingpipeline.LeaseInput, leaseExpiresAt time.Time) error {
	runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, &runErr, d.config.AttemptShutdown)
	attemptErr := errors.Join(runErr, closeErr, shutdownErr)
	if attemptErr != nil {
		reportErr := d.reportAttemptFailure(ctx, lease, attemptErr)
		if d.config.Slots > 1 {
			return errors.Join(reportErr, shutdownErr)
		}
		return reportErr
	}
	if err := d.completeCapture(ctx, lease, leaseExpiresAt, false); err != nil {
		return d.reportCompletionFailure(ctx, lease, err)
	}
	return nil
}

func (d *CaptureDaemon) interruptCaptureAttempt(ctx context.Context, attempt CaptureAttempt, cancelAttempt context.CancelFunc, result <-chan error, lease recordingpipeline.LeaseInput, leaseExpiresAt time.Time, stopErr error) error {
	// A claim or successful heartbeat leaves at least Lease-HeartbeatInterval of
	// authority. Keep the entire bounded cleanup plus relinquish request inside
	// that live window; an unexpectedly late wakeup takes the safe lease-expiry
	// fallback instead of releasing authority while cleanup may still be active.
	handoffFitsLease := d.config.Now().UTC().Add(d.config.HandoffShutdown + d.config.RelinquishTimeout).Before(leaseExpiresAt)
	runErr, closeErr, shutdownErr := d.shutdownCaptureAttempt(cancelAttempt, attempt, result, nil, d.config.HandoffShutdown)
	if shutdownErr != nil {
		return errors.Join(stopErr, runErr, closeErr, shutdownErr)
	}
	if !handoffFitsLease {
		return errors.Join(stopErr, runErr, closeErr, ErrCaptureHandoffWindow)
	}
	relinquishErr := d.relinquishCapture(context.WithoutCancel(ctx), lease)
	if relinquishErr != nil {
		return fmt.Errorf("relinquish recorder capture lease: %w", errors.Join(stopErr, runErr, closeErr, relinquishErr))
	}
	return stopErr
}

func (d *CaptureDaemon) relinquishCapture(ctx context.Context, lease recordingpipeline.LeaseInput) error {
	ctx, cancel := context.WithTimeout(ctx, d.config.RelinquishTimeout)
	defer cancel()
	requestUncertain := false
	for {
		_, err := d.control.RelinquishCapture(ctx, lease)
		if err == nil || requestUncertain && errors.Is(err, ErrControlPlaneFenced) {
			return nil
		}
		if !errors.Is(err, ErrControlPlaneRetryable) {
			return err
		}
		requestUncertain = true
		if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
			return errors.Join(err, waitErr)
		}
	}
}

func (d *CaptureDaemon) completeCapture(ctx context.Context, lease recordingpipeline.LeaseInput, expiresAt time.Time, retry bool) error {
	timeout := d.config.CompletionTimeout
	if retry && timeout > DefaultCompletionRetry {
		timeout = DefaultCompletionRetry
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result := make(chan error, 1)
	// A timeout would otherwise hide the API answer that kept the retries going.
	var lastRetryable atomic.Pointer[error]
	var lastHTTP atomic.Pointer[error]
	timedOut := func() error {
		cause := ctx.Err()
		last := lastHTTP.Load()
		if last == nil {
			last = lastRetryable.Load()
		}
		if last != nil {
			cause = errors.Join(cause, *last)
		}
		return completionStageError{stage: "api_complete", outcome: "timed_out", cause: cause}
	}
	// Freezing the presentation performs object I/O; preserve the same capture
	// authority while it runs, without starting another media attempt.
	go func() {
		for {
			err := captureOperation(func() error { _, err := d.control.Complete(ctx, lease); return err })
			if err == nil || !errors.Is(err, ErrControlPlaneRetryable) {
				result <- err
				return
			}
			lastRetryable.Store(&err)
			var httpErr HTTPError
			if errors.As(err, &httpErr) {
				lastHTTP.Store(&err)
			}
			if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
				result <- errors.Join(err, waitErr)
				return
			}
		}
	}()
	for {
		select {
		case err := <-result:
			if err != nil {
				if ctx.Err() != nil {
					return timedOut()
				}
				return completionStageError{stage: "api_complete", outcome: "returned", cause: err}
			}
			return nil
		case <-ctx.Done():
			return timedOut()
		case <-d.config.After(d.config.HeartbeatInterval):
			job, err := d.heartbeat(ctx, lease, expiresAt)
			if err != nil {
				return completionStageError{stage: "lease_renewal", outcome: "returned", cause: err}
			}
			if _, err := renewedCaptureLease(lease, job, d.config.Lease, d.config.Now().UTC()); err != nil {
				return completionStageError{stage: "lease_renewal", outcome: "returned", cause: err}
			}
			expiresAt = job.LeaseExpiresAt.UTC()
		}
	}
}

func (d *CaptureDaemon) heartbeat(ctx context.Context, lease recordingpipeline.LeaseInput, expiresAt time.Time) (recordingpipeline.Job, error) {
	for {
		job, err := d.control.Heartbeat(ctx, lease)
		if err == nil || !errors.Is(err, ErrControlPlaneRetryable) {
			return job, err
		}
		now := d.config.Now().UTC()
		if !now.Add(d.config.ClaimRetryWait).Before(expiresAt) {
			return recordingpipeline.Job{}, err
		}
		if waitErr := d.config.Wait(ctx, d.config.ClaimRetryWait); waitErr != nil {
			return recordingpipeline.Job{}, errors.Join(err, waitErr)
		}
	}
}

func (d *CaptureDaemon) shutdownCaptureAttempt(cancel context.CancelFunc, attempt CaptureAttempt, result <-chan error, knownRunErr *error, timeout time.Duration) (error, error, error) {
	cancel()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), timeout)
	defer cancelShutdown()
	var runErr, shutdownErr error
	if knownRunErr == nil {
		select {
		case runErr = <-result:
		case <-shutdownCtx.Done():
			if d.config.Slots == 1 {
				return nil, nil, ErrCaptureAttemptShutdown
			}
			// A lease fence cannot stop local media work. Keep this slot occupied
			// until Run exits, even when it ignores its cancellation deadline.
			shutdownErr = ErrCaptureAttemptShutdown
			runErr = <-result
		}
	} else {
		runErr = *knownRunErr
	}
	closeResult := make(chan error, 1)
	go func() { closeResult <- captureOperation(func() error { return attempt.Close(shutdownCtx) }) }()
	var closeErr error
	select {
	case closeErr = <-closeResult:
	case <-shutdownCtx.Done():
		if d.config.Slots == 1 {
			return runErr, nil, ErrCaptureAttemptShutdown
		}
		shutdownErr = ErrCaptureAttemptShutdown
		closeErr = <-closeResult
	}
	if closeErr != nil {
		shutdownErr = ErrCaptureAttemptShutdown
		if d.config.Slots > 1 {
			// A failed or panicking Close cannot prove that resources were freed.
			shutdownErr = errors.Join(shutdownErr, errCaptureSlotRetired)
		}
	}
	return runErr, closeErr, shutdownErr
}

func captureAttemptContext(ctx context.Context, claim ClaimResult) (context.Context, error) {
	if claim.ClaimRequestID.IsZero() || len(claim.EnvelopeDigest) != sha256.Size {
		return nil, fmt.Errorf("%w: capture attempt correlation", ErrInvalidCaptureDaemon)
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte("chalk.recording.capture_attempt.v1"))
	claimRequestID := claim.ClaimRequestID.Bytes()
	_, _ = digest.Write(claimRequestID[:])
	_, _ = digest.Write(claim.EnvelopeDigest)
	correlation := digest.Sum(nil)
	var traceID trace.TraceID
	var spanID trace.SpanID
	copy(traceID[:], correlation[:len(traceID)])
	copy(spanID[:], correlation[len(traceID):len(traceID)+len(spanID)])
	clear(correlation)
	if !traceID.IsValid() || !spanID.IsValid() {
		return nil, fmt.Errorf("%w: capture attempt trace correlation", ErrInvalidCaptureDaemon)
	}
	ctx = observability.ContextWithJourneyID(ctx, claim.ClaimRequestID)
	return trace.ContextWithSpanContext(ctx, trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: trace.FlagsSampled,
	})), nil
}

func (d *CaptureDaemon) reportAttemptFailure(ctx context.Context, lease recordingpipeline.LeaseInput, cause error) error {
	if cause == nil {
		cause = errors.New("capture attempt failed without a cause")
	}
	availableAt := d.config.Now().UTC().Add(d.config.AttemptRetryDelay)
	_, reportErr := d.control.Fail(ctx, recordingpipeline.FailureInput{
		LeaseInput:  lease,
		AvailableAt: availableAt,
		ErrorCode:   defaultCaptureFailureCode,
		ErrorDetail: boundedFailureDetail(cause),
	})
	if reportErr != nil {
		return fmt.Errorf("report recorder capture failure: %w", errors.Join(cause, reportErr))
	}
	return nil
}

type completionStageError struct {
	stage   string
	outcome string
	cause   error
}

func (e completionStageError) Error() string {
	return "capture completion " + e.stage + " " + e.outcome
}
func (e completionStageError) Unwrap() error { return e.cause }

func completionFailureDetail(err error) string {
	stage, outcome, class, status, apiCode := "api_complete", "returned", "unknown", 0, ""
	var stageErr completionStageError
	if errors.As(err, &stageErr) {
		stage, outcome = stageErr.stage, stageErr.outcome
	}
	var httpErr HTTPError
	var transportErr TransportError
	var protocolErr ProtocolError
	switch {
	case errors.As(err, &httpErr):
		class, status, apiCode = "http", httpErr.Status, httpErr.Code
	case errors.Is(err, context.DeadlineExceeded):
		class = "deadline"
	case errors.As(err, &transportErr):
		class = "transport"
	case errors.As(err, &protocolErr):
		class = "protocol"
	case errors.Is(err, ErrControlPlaneFenced):
		class = "fenced"
	}
	detail := fmt.Sprintf("stage=%s outcome=%s error_class=%s http_status=%d", stage, outcome, class, status)
	if apiCode != "" {
		detail += " api_error_code=" + apiCode
	}
	return detail
}

func (d *CaptureDaemon) reportCompletionFailure(ctx context.Context, lease recordingpipeline.LeaseInput, cause error) error {
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.config.RelinquishTimeout)
	defer cancel()
	errorCode := completionFailureCode
	var httpErr HTTPError
	if errors.As(cause, &httpErr) && httpErr.Code == "recording.capture_stop_publication_failed" {
		errorCode = "capture_stop_publication_failed"
	}
	_, reportErr := d.control.Fail(reportCtx, recordingpipeline.FailureInput{
		LeaseInput: lease, AvailableAt: d.config.Now().UTC().Add(DefaultAttemptRetryDelay),
		ErrorCode: errorCode, ErrorDetail: completionFailureDetail(cause),
	})
	if reportErr != nil {
		return fmt.Errorf("report capture completion failure (%s): %w", completionFailureDetail(cause), reportErr)
	}
	return nil
}

func captureLeaseInput(claim ClaimResult, leaseFor time.Duration) (recordingpipeline.LeaseInput, error) {
	jobID, err := utilities.ParseID(claim.Envelope.JobID)
	if err != nil || claim.Envelope.AttemptCount <= 0 || claim.Envelope.FencingGeneration <= 0 || claim.Envelope.CaptureEpoch <= 0 || claim.LeaseToken == "" || claim.LeaseOwner == "" || claim.LeaseExpiresAt.IsZero() {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: claim authority", ErrInvalidCaptureDaemon)
	}
	input := recordingpipeline.LeaseInput{
		JobID:             jobID,
		AttemptCount:      claim.Envelope.AttemptCount,
		FencingGeneration: claim.Envelope.FencingGeneration,
		LeaseToken:        claim.LeaseToken,
		LeaseOwner:        claim.LeaseOwner,
		LeaseFor:          leaseFor,
		CaptureEpoch:      claim.Envelope.CaptureEpoch,
		EnvelopeDigest:    append([]byte(nil), claim.EnvelopeDigest...),
	}
	if err := recordingpipeline.ValidateLeaseInput(input); err != nil {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: %w", ErrInvalidCaptureDaemon, err)
	}
	return input, nil
}

func renewedCaptureLease(previous recordingpipeline.LeaseInput, job recordingpipeline.Job, leaseFor time.Duration, now time.Time) (recordingpipeline.LeaseInput, error) {
	if job.ID != previous.JobID || job.AttemptCount != previous.AttemptCount || job.FencingGeneration != previous.FencingGeneration || job.CaptureEpoch != previous.CaptureEpoch || job.LeaseToken == nil || job.LeaseOwner == nil || job.LeaseExpiresAt == nil || *job.LeaseToken != previous.LeaseToken || *job.LeaseOwner != previous.LeaseOwner || !job.LeaseExpiresAt.After(now) {
		return recordingpipeline.LeaseInput{}, fmt.Errorf("%w: heartbeat authority mismatch", ErrInvalidCaptureDaemon)
	}
	previous.LeaseFor = leaseFor
	return previous, nil
}

func boundedFailureDetail(err error) string {
	const maximumBytes = 512
	detail := err.Error()
	if len(detail) <= maximumBytes {
		return detail
	}
	end := maximumBytes
	for end > 0 && !utf8.ValidString(detail[:end]) {
		end--
	}
	return detail[:end]
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
