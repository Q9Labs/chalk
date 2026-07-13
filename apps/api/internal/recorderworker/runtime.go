package recorderworker

import (
	"context"
	"errors"
	"sync"
	"time"
)

type EventReporter interface {
	Report(context.Context, WorkerEvent) error
}

type Runtime struct {
	job               Job
	reporter          EventReporter
	now               func() time.Time
	mu                sync.Mutex
	terminal          bool
	terminalReporting bool
}

func NewRuntime(job Job, reporter EventReporter, now func() time.Time) (*Runtime, error) {
	if reporter == nil || now == nil {
		return nil, errors.New("worker runtime requires reporter and clock")
	}
	if err := job.Validate(now()); err != nil {
		return nil, err
	}
	return &Runtime{job: job, reporter: reporter, now: now}, nil
}

func (r *Runtime) Heartbeat(ctx context.Context, leaseExpiresAt time.Time, usage ResourceUse) error {
	return r.emit(ctx, EventHeartbeat, &Heartbeat{LeaseExpiresAt: leaseExpiresAt, ResourceUse: usage}, nil, nil)
}

func (r *Runtime) Progress(ctx context.Context, stage string, completed, total, bytes int64, objectKey string) error {
	return r.emit(ctx, EventProgress, nil, &Progress{Stage: stage, Completed: completed, Total: total, Bytes: bytes, ObjectKey: objectKey}, nil)
}

func (r *Runtime) Complete(ctx context.Context, artifactKey, artifactHash string, usage ResourceUse) error {
	return r.emitTerminal(ctx, TerminalResult{Outcome: "succeeded", ArtifactKey: artifactKey, ArtifactHash: artifactHash, ResourceUse: usage})
}

func (r *Runtime) Fail(ctx context.Context, code, detail string, usage ResourceUse) error {
	return r.emitTerminal(ctx, TerminalResult{Outcome: "failed", ErrorCode: code, ErrorDetail: detail, ResourceUse: usage})
}

func (r *Runtime) emitTerminal(ctx context.Context, result TerminalResult) error {
	r.mu.Lock()
	if r.terminal || r.terminalReporting {
		r.mu.Unlock()
		return errors.New("worker runtime already terminal")
	}
	r.terminalReporting = true
	r.mu.Unlock()
	err := r.emit(ctx, EventTerminal, nil, nil, &result)
	r.mu.Lock()
	r.terminalReporting = false
	if err == nil {
		r.terminal = true
	}
	r.mu.Unlock()
	return err
}

func (r *Runtime) emit(ctx context.Context, eventType EventType, heartbeat *Heartbeat, progress *Progress, terminal *TerminalResult) error {
	r.mu.Lock()
	terminalState := r.terminal || (r.terminalReporting && eventType != EventTerminal)
	r.mu.Unlock()
	if terminalState && eventType != EventTerminal {
		return errors.New("worker runtime is terminal")
	}
	event := WorkerEvent{ProtocolVersion: ProtocolVersion, Type: eventType, JobID: r.job.JobID, TenantID: r.job.TenantID, SessionID: r.job.SessionID, Attempt: r.job.Attempt, FencingGeneration: r.job.FencingGeneration, JourneyID: r.job.JourneyID, TraceParent: r.job.TraceParent, At: r.now(), Heartbeat: heartbeat, Progress: progress, Terminal: terminal}
	if err := event.Validate(r.now()); err != nil {
		return err
	}
	return r.reporter.Report(ctx, event)
}
