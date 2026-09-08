package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

const (
	SerialWorkerReadyCapacity  = 1
	ReadinessRefreshInterval   = 10 * time.Second
	ReadinessRequestTimeout    = 5 * time.Second
	ReadinessShutdownGrace     = 22 * time.Second
	ReadinessReasonReady       = "worker_ready"
	ReadinessReasonDraining    = "worker_draining"
	maximumReadinessReasonSize = 256
)

var (
	ErrInvalidWorkerReadiness = errors.New("invalid recorder worker readiness")
	ErrReadinessFailure       = errors.New("recorder worker readiness lifecycle failed")
	ErrReadinessStopped       = errors.New("recorder worker readiness lifecycle stopped")
	ErrWorkerDraining         = errors.New("recorder worker is draining")
)

// WorkerReadiness describes this process's qualified serial processing slot.
// It is capacity, not a claim-time idle counter: each daemon itself permits
// only one active claim and the fleet controller accounts for active leases.
type WorkerReadiness struct {
	AdmissionOpen bool
	ReadyCapacity int
	Reason        string
}

type WorkerReadinessReceipt struct {
	Role workeridentity.Role
	WorkerReadiness
	ObservedAt time.Time
	UpdatedAt  time.Time
}

type readinessRequest struct {
	AdmissionOpen bool   `json:"admission_open"`
	ReadyCapacity int    `json:"ready_capacity"`
	Reason        string `json:"reason"`
}

type readinessResponse struct {
	Role          string `json:"role"`
	AdmissionOpen bool   `json:"admission_open"`
	ReadyCapacity int    `json:"ready_capacity"`
	Reason        string `json:"reason"`
	ObservedAt    string `json:"observed_at"`
	UpdatedAt     string `json:"updated_at"`
}

// ReportReadiness publishes through the same mTLS control-plane client used by
// worker claims. The worker omits its wall clock; the API returns the database
// receipt time that becomes authoritative for claim liveness.
func (c *ControlPlaneClient) ReportReadiness(ctx context.Context, readiness WorkerReadiness) (WorkerReadinessReceipt, error) {
	if err := validateWorkerReadiness(readiness); err != nil {
		return WorkerReadinessReceipt{}, err
	}
	body, _, err := c.do(ctx, http.MethodPost, "/internal/v1/recorder/pool-health", readinessRequest(readiness), ControlPlaneResponseLimit)
	if err != nil {
		return WorkerReadinessReceipt{}, err
	}
	var response readinessResponse
	if err := decodeBoundedJSON(body, &response, ControlPlaneResponseLimit); err != nil {
		return WorkerReadinessReceipt{}, ProtocolError{Err: err}
	}
	role := workeridentity.Role(response.Role)
	if role != workeridentity.RoleCapture && role != workeridentity.RoleRender || response.Reason != readiness.Reason ||
		response.AdmissionOpen && (!readiness.AdmissionOpen || response.ReadyCapacity != readiness.ReadyCapacity) ||
		!response.AdmissionOpen && response.ReadyCapacity != 0 {
		return WorkerReadinessReceipt{}, ProtocolError{Err: errors.New("readiness response mismatch")}
	}
	observedAt, err := time.Parse(time.RFC3339Nano, response.ObservedAt)
	if err != nil || observedAt.IsZero() {
		return WorkerReadinessReceipt{}, ProtocolError{Err: errors.New("readiness response observation time")}
	}
	updatedAt, err := time.Parse(time.RFC3339Nano, response.UpdatedAt)
	if err != nil || updatedAt.IsZero() {
		return WorkerReadinessReceipt{}, ProtocolError{Err: errors.New("readiness response update time")}
	}
	return WorkerReadinessReceipt{
		Role: role,
		WorkerReadiness: WorkerReadiness{
			AdmissionOpen: response.AdmissionOpen, ReadyCapacity: response.ReadyCapacity, Reason: response.Reason,
		},
		ObservedAt: observedAt, UpdatedAt: updatedAt,
	}, nil
}

func validateWorkerReadiness(readiness WorkerReadiness) error {
	if readiness.Reason == "" || strings.TrimSpace(readiness.Reason) != readiness.Reason || len(readiness.Reason) > maximumReadinessReasonSize ||
		readiness.AdmissionOpen && readiness.ReadyCapacity != SerialWorkerReadyCapacity ||
		!readiness.AdmissionOpen && readiness.ReadyCapacity != 0 {
		return ErrInvalidWorkerReadiness
	}
	return nil
}

type ReadinessControl interface {
	ReportReadiness(context.Context, WorkerReadiness) (WorkerReadinessReceipt, error)
}

type DrainableWorkerDaemon interface {
	Run(context.Context) error
	Drain()
}

// ReadinessReporter opens admission only after construction-time preflight has
// succeeded, supervises fresh liveness reports while the daemon runs, and
// clears admission with a detached bounded request whenever either exits.
type ReadinessReporter struct {
	control         ReadinessControl
	refreshInterval time.Duration
	requestTimeout  time.Duration
	shutdownGrace   time.Duration
	after           func(time.Duration) <-chan time.Time
}

func NewReadinessReporter(control ReadinessControl) (*ReadinessReporter, error) {
	if control == nil {
		return nil, ErrInvalidWorkerReadiness
	}
	return &ReadinessReporter{
		control: control, refreshInterval: ReadinessRefreshInterval,
		requestTimeout: ReadinessRequestTimeout, shutdownGrace: ReadinessShutdownGrace, after: time.After,
	}, nil
}

func (r *ReadinessReporter) Run(ctx context.Context, daemon DrainableWorkerDaemon) error {
	if r == nil || r.control == nil || r.after == nil || r.refreshInterval <= 0 || r.requestTimeout <= 0 || r.shutdownGrace < r.requestTimeout || daemon == nil {
		return ErrInvalidWorkerReadiness
	}
	receipt, err := r.publish(ctx, true)
	if err != nil {
		if ctx.Err() != nil {
			return errors.Join(ctx.Err(), r.closeAdmission(ctx))
		}
		return errors.Join(readinessFailure("open recorder worker admission", err), r.closeAdmission(ctx))
	}
	if !receipt.AdmissionOpen {
		return r.closeAdmission(ctx)
	}

	runCtx, cancelRun := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelRun()
	daemonResult := make(chan error, 1)
	go func() {
		daemonResult <- daemon.Run(runCtx)
	}()

	refresh := r.after(r.refreshInterval)
	authorityDraining := false
	for {
		select {
		case daemonErr := <-daemonResult:
			closeErr := r.closeAdmission(ctx)
			if ctx.Err() != nil {
				return errors.Join(ctx.Err(), unexpectedDaemonError(daemonErr, authorityDraining), closeErr)
			}
			if authorityDraining && errors.Is(daemonErr, ErrWorkerDraining) {
				return closeErr
			}
			if daemonErr == nil {
				daemonErr = ErrReadinessStopped
			}
			return errors.Join(readinessFailure("run recorder worker daemon", daemonErr), closeErr)
		case <-ctx.Done():
			return r.shutdown(ctx, daemon, cancelRun, daemonResult)
		case <-refresh:
			receipt, err := r.publish(ctx, true)
			if err != nil {
				if ctx.Err() != nil {
					return r.shutdown(ctx, daemon, cancelRun, daemonResult)
				}
				cancelRun()
				daemonErr := <-daemonResult
				return errors.Join(
					readinessFailure("refresh recorder worker readiness", err),
					daemonErr,
					r.closeAdmission(ctx),
				)
			}
			if !receipt.AdmissionOpen {
				daemon.Drain()
				authorityDraining = true
				refresh = nil
				continue
			}
			refresh = r.after(r.refreshInterval)
		}
	}
}

func (r *ReadinessReporter) shutdown(ctx context.Context, daemon DrainableWorkerDaemon, cancelRun context.CancelFunc, daemonResult <-chan error) error {
	daemon.Drain()
	shutdownExpired := r.after(r.shutdownGrace)
	closeErr := r.closeAdmission(ctx)
	select {
	case daemonErr := <-daemonResult:
		return errors.Join(ctx.Err(), unexpectedDaemonError(daemonErr, true), closeErr)
	case <-shutdownExpired:
		cancelRun()
		return errors.Join(ctx.Err(), closeErr)
	}
}

func (r *ReadinessReporter) closeAdmission(ctx context.Context) error {
	_, err := r.publish(context.WithoutCancel(ctx), false)
	if err == nil {
		return nil
	}
	return readinessFailure("close recorder worker admission", err)
}

func readinessFailure(operation string, err error) error {
	return fmt.Errorf("%w: %s: %w", ErrReadinessFailure, operation, err)
}

func unexpectedDaemonError(err error, draining bool) error {
	if err == nil || draining && errors.Is(err, ErrWorkerDraining) {
		return nil
	}
	return readinessFailure("run recorder worker daemon", err)
}

func (r *ReadinessReporter) publish(ctx context.Context, ready bool) (WorkerReadinessReceipt, error) {
	requestCtx, cancel := context.WithTimeout(ctx, r.requestTimeout)
	defer cancel()
	readiness := WorkerReadiness{Reason: ReadinessReasonDraining}
	if ready {
		readiness = WorkerReadiness{
			AdmissionOpen: true, ReadyCapacity: SerialWorkerReadyCapacity, Reason: ReadinessReasonReady,
		}
	}
	return r.control.ReportReadiness(requestCtx, readiness)
}

var _ ReadinessControl = (*ControlPlaneClient)(nil)
