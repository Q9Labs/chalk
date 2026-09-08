package recorderworker

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestControlPlaneClientReportsReadinessWithoutWorkerTimestamp(t *testing.T) {
	t.Parallel()
	client, err := NewControlPlaneClient("https://control.example", &http.Client{Transport: readinessRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/internal/v1/recorder/pool-health" || request.Method != http.MethodPost {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		defer request.Body.Close()
		body, _ := io.ReadAll(request.Body)
		if strings.Contains(string(body), "observed_at") || string(body) != `{"admission_open":true,"ready_capacity":1,"reason":"worker_ready"}` {
			t.Fatalf("body = %s", body)
		}
		return readinessHTTPResponse(http.StatusOK, `{"role":"capture","admission_open":true,"ready_capacity":1,"reason":"worker_ready","observed_at":"2026-09-06T20:00:00.123Z","updated_at":"2026-09-06T20:00:00.124Z"}`), nil
	})})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	receipt, err := client.ReportReadiness(t.Context(), WorkerReadiness{
		AdmissionOpen: true, ReadyCapacity: SerialWorkerReadyCapacity, Reason: ReadinessReasonReady,
	})
	if err != nil {
		t.Fatalf("report readiness: %v", err)
	}
	if receipt.Role != "capture" || !receipt.AdmissionOpen || receipt.ReadyCapacity != 1 || receipt.ObservedAt.IsZero() {
		t.Fatalf("receipt = %#v", receipt)
	}
}

func TestControlPlaneClientRejectsReadinessResponseMismatch(t *testing.T) {
	t.Parallel()
	client, _ := NewControlPlaneClient("https://control.example", &http.Client{Transport: readinessRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return readinessHTTPResponse(http.StatusOK, `{"role":"capture","admission_open":true,"ready_capacity":4,"reason":"worker_ready","observed_at":"2026-09-06T20:00:00Z","updated_at":"2026-09-06T20:00:00Z"}`), nil
	})})
	_, err := client.ReportReadiness(t.Context(), WorkerReadiness{
		AdmissionOpen: true, ReadyCapacity: SerialWorkerReadyCapacity, Reason: ReadinessReasonReady,
	})
	if !errors.Is(err, ErrControlPlaneProtocol) {
		t.Fatalf("error = %v", err)
	}
}

func TestControlPlaneClientAcceptsAuthoritativeDrainingReceipt(t *testing.T) {
	t.Parallel()
	client, _ := NewControlPlaneClient("https://control.example", &http.Client{Transport: readinessRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return readinessHTTPResponse(http.StatusOK, `{"role":"render","admission_open":false,"ready_capacity":0,"reason":"worker_ready","observed_at":"2026-09-06T20:00:00Z","updated_at":"2026-09-06T20:00:00Z"}`), nil
	})})
	receipt, err := client.ReportReadiness(t.Context(), WorkerReadiness{
		AdmissionOpen: true, ReadyCapacity: SerialWorkerReadyCapacity, Reason: ReadinessReasonReady,
	})
	if err != nil || receipt.AdmissionOpen || receipt.ReadyCapacity != 0 || receipt.Role != "render" {
		t.Fatalf("receipt/error = %#v/%v", receipt, err)
	}
}

func TestReadinessReporterGatesRefreshesAndDrainsDaemon(t *testing.T) {
	t.Parallel()
	control := &readinessControlStub{reports: make(chan WorkerReadiness, 4)}
	ticks := make(chan time.Time, 1)
	reporter := &ReadinessReporter{
		control: control, refreshInterval: time.Second, requestTimeout: time.Second,
		shutdownGrace: time.Second, after: func(time.Duration) <-chan time.Time { return ticks },
	}
	daemon := newReadinessDaemonStub()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- reporter.Run(ctx, daemon) }()

	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	select {
	case <-daemon.started:
	case <-time.After(time.Second):
		t.Fatal("daemon did not start after initial readiness")
	}
	ticks <- time.Now()
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	cancel()
	assertReadinessReport(t, control.reports, false, 0, ReadinessReasonDraining)
	select {
	case <-daemon.stopped:
	case <-time.After(time.Second):
		t.Fatal("daemon did not stop")
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("run error = %v", err)
	}
	if control.closedContextCanceled {
		t.Fatal("drain report inherited canceled worker context")
	}
	select {
	case <-daemon.drained:
	default:
		t.Fatal("daemon was canceled without entering graceful drain")
	}
}

func TestReadinessReporterFailsClosedWhenRefreshFails(t *testing.T) {
	t.Parallel()
	refreshErr := errors.New("control unavailable")
	control := &readinessControlStub{reports: make(chan WorkerReadiness, 3), failAt: 2, err: refreshErr}
	ticks := make(chan time.Time, 1)
	reporter := &ReadinessReporter{
		control: control, refreshInterval: time.Second, requestTimeout: time.Second,
		shutdownGrace: time.Second, after: func(time.Duration) <-chan time.Time { return ticks },
	}
	daemon := newReadinessDaemonStub()
	result := make(chan error, 1)
	go func() { result <- reporter.Run(context.Background(), daemon) }()
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	ticks <- time.Now()
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	assertReadinessReport(t, control.reports, false, 0, ReadinessReasonDraining)
	if err := <-result; !errors.Is(err, refreshErr) || !errors.Is(err, ErrReadinessFailure) {
		t.Fatalf("run error = %v", err)
	}
	select {
	case <-daemon.stopped:
	case <-time.After(time.Second):
		t.Fatal("daemon was not canceled after refresh failure")
	}
}

func TestReadinessReporterGracefullyDrainsWhenAuthorityClosesAdmission(t *testing.T) {
	t.Parallel()
	control := &readinessControlStub{reports: make(chan WorkerReadiness, 4), closeAt: 2}
	ticks := make(chan time.Time, 1)
	reporter := &ReadinessReporter{
		control: control, refreshInterval: time.Second, requestTimeout: time.Second,
		shutdownGrace: time.Second, after: func(time.Duration) <-chan time.Time { return ticks },
	}
	daemon := newReadinessDaemonStub()
	result := make(chan error, 1)
	go func() { result <- reporter.Run(context.Background(), daemon) }()
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	<-daemon.started
	ticks <- time.Now()
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	select {
	case <-daemon.drained:
	case <-time.After(time.Second):
		t.Fatal("daemon did not enter graceful drain")
	}
	assertReadinessReport(t, control.reports, false, 0, ReadinessReasonDraining)
	if err := <-result; err != nil {
		t.Fatalf("graceful drain error = %v", err)
	}
}

func TestReadinessReporterDoesNotStartDaemonWhenInitialReportFails(t *testing.T) {
	t.Parallel()
	reportErr := errors.New("not bound")
	control := &readinessControlStub{reports: make(chan WorkerReadiness, 2), failAt: 1, err: reportErr}
	reporter, _ := NewReadinessReporter(control)
	daemon := newReadinessDaemonStub()
	err := reporter.Run(t.Context(), daemon)
	if !errors.Is(err, reportErr) || !errors.Is(err, ErrReadinessFailure) {
		t.Fatalf("run error = %v", err)
	}
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	assertReadinessReport(t, control.reports, false, 0, ReadinessReasonDraining)
	select {
	case <-daemon.started:
		t.Fatal("daemon started before readiness succeeded")
	default:
	}
}

func TestReadinessReporterForcesCancellationAfterShutdownGrace(t *testing.T) {
	t.Parallel()
	control := &readinessControlStub{reports: make(chan WorkerReadiness, 2)}
	reporter := &ReadinessReporter{
		control: control, refreshInterval: time.Hour, requestTimeout: 10 * time.Millisecond,
		shutdownGrace: 20 * time.Millisecond, after: time.After,
	}
	daemon := newBlockingReadinessDaemonStub()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- reporter.Run(ctx, daemon) }()
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	<-daemon.started
	cancel()
	assertReadinessReport(t, control.reports, false, 0, ReadinessReasonDraining)
	select {
	case <-daemon.drained:
	case <-time.After(time.Second):
		t.Fatal("daemon did not enter drain before forced cancellation")
	}
	select {
	case <-daemon.canceled:
	case <-time.After(time.Second):
		t.Fatal("daemon was not canceled after shutdown grace")
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("run error = %v", err)
	}
}

func TestReadinessReporterLetsActiveWorkFinishDuringShutdownGrace(t *testing.T) {
	t.Parallel()
	control := &readinessControlStub{reports: make(chan WorkerReadiness, 2)}
	reporter := &ReadinessReporter{
		control: control, refreshInterval: time.Hour, requestTimeout: 100 * time.Millisecond,
		shutdownGrace: time.Second, after: time.After,
	}
	daemon := newBlockingReadinessDaemonStub()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- reporter.Run(ctx, daemon) }()
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	<-daemon.started
	cancel()
	assertReadinessReport(t, control.reports, false, 0, ReadinessReasonDraining)
	select {
	case <-daemon.drained:
	case <-time.After(time.Second):
		t.Fatal("daemon did not enter drain")
	}
	select {
	case <-result:
		t.Fatal("reporter returned before active work finished")
	default:
	}
	close(daemon.finish)
	if err := <-result; !errors.Is(err, context.Canceled) || errors.Is(err, ErrReadinessFailure) {
		t.Fatalf("run error = %v", err)
	}
	select {
	case <-daemon.canceled:
		t.Fatal("daemon was canceled before active work finished")
	default:
	}
}

func TestReadinessReporterPreservesCloseFailureDuringShutdown(t *testing.T) {
	t.Parallel()
	closeErr := errors.New("close unavailable")
	control := &readinessControlStub{reports: make(chan WorkerReadiness, 2), failAt: 2, err: closeErr}
	reporter, _ := NewReadinessReporter(control)
	daemon := newReadinessDaemonStub()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- reporter.Run(ctx, daemon) }()
	assertReadinessReport(t, control.reports, true, 1, ReadinessReasonReady)
	<-daemon.started
	cancel()
	assertReadinessReport(t, control.reports, false, 0, ReadinessReasonDraining)
	err := <-result
	if !errors.Is(err, context.Canceled) || !errors.Is(err, ErrReadinessFailure) || !errors.Is(err, closeErr) {
		t.Fatalf("run error = %v", err)
	}
}

type readinessControlStub struct {
	mu                    sync.Mutex
	calls                 int
	failAt                int
	err                   error
	reports               chan WorkerReadiness
	closedContextCanceled bool
	closeAt               int
}

func (s *readinessControlStub) ReportReadiness(ctx context.Context, readiness WorkerReadiness) (WorkerReadinessReceipt, error) {
	s.mu.Lock()
	s.calls++
	call := s.calls
	if !readiness.AdmissionOpen && ctx.Err() != nil {
		s.closedContextCanceled = true
	}
	s.mu.Unlock()
	s.reports <- readiness
	if call == s.failAt {
		return WorkerReadinessReceipt{}, s.err
	}
	receipt := WorkerReadinessReceipt{Role: "capture", WorkerReadiness: readiness, ObservedAt: time.Now(), UpdatedAt: time.Now()}
	if call == s.closeAt {
		receipt.AdmissionOpen = false
		receipt.ReadyCapacity = 0
	}
	return receipt, nil
}

type readinessDaemonStub struct {
	started chan struct{}
	stopped chan struct{}
	drain   chan struct{}
	drained chan struct{}
}

func (s *readinessDaemonStub) Run(ctx context.Context) error {
	close(s.started)
	select {
	case <-ctx.Done():
		close(s.stopped)
		return ctx.Err()
	case <-s.drain:
		close(s.drained)
		close(s.stopped)
		return ErrWorkerDraining
	}
}

func (s *readinessDaemonStub) Drain() {
	select {
	case <-s.drain:
	default:
		close(s.drain)
	}
}

func newReadinessDaemonStub() *readinessDaemonStub {
	return &readinessDaemonStub{
		started: make(chan struct{}), stopped: make(chan struct{}),
		drain: make(chan struct{}), drained: make(chan struct{}),
	}
}

type blockingReadinessDaemonStub struct {
	started  chan struct{}
	drain    chan struct{}
	drained  chan struct{}
	finish   chan struct{}
	canceled chan struct{}
}

func (s *blockingReadinessDaemonStub) Run(ctx context.Context) error {
	close(s.started)
	select {
	case <-s.drain:
		close(s.drained)
	case <-ctx.Done():
		close(s.canceled)
		return ctx.Err()
	}
	select {
	case <-s.finish:
		return ErrWorkerDraining
	case <-ctx.Done():
		close(s.canceled)
		return ctx.Err()
	}
}

func (s *blockingReadinessDaemonStub) Drain() {
	select {
	case <-s.drain:
	default:
		close(s.drain)
	}
}

func newBlockingReadinessDaemonStub() *blockingReadinessDaemonStub {
	return &blockingReadinessDaemonStub{
		started: make(chan struct{}), drain: make(chan struct{}),
		drained: make(chan struct{}), finish: make(chan struct{}), canceled: make(chan struct{}),
	}
}

func assertReadinessReport(t *testing.T, reports <-chan WorkerReadiness, admissionOpen bool, capacity int, reason string) {
	t.Helper()
	select {
	case report := <-reports:
		if report.AdmissionOpen != admissionOpen || report.ReadyCapacity != capacity || report.Reason != reason {
			t.Fatalf("report = %#v", report)
		}
	case <-time.After(time.Second):
		t.Fatal("readiness report timed out")
	}
}

func readinessHTTPResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

type readinessRoundTripFunc func(*http.Request) (*http.Response, error)

func (function readinessRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
