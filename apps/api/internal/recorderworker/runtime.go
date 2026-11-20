package recorderworker

import (
	"context"
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
