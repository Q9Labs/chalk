package presenting

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectcleanup"
)

const ReconcileBatchLimit = 50

// ReconcileWorker is the control-plane backstop for renderer invocations lost
// to deploys, API restarts or Lambda allocation failures. Every pass mints a
// fresh short-lived capability; no durable renderer credential is involved.
type ReconcileWorker struct {
	service Service
}

func NewReconcileWorker(service Service) ReconcileWorker {
	return ReconcileWorker{service: service}
}

func (w ReconcileWorker) Kind() objectcleanup.Kind {
	return objectcleanup.Kind{Name: "presenting_render_reconcile", Label: "Presenting render reconcile"}
}

func (w ReconcileWorker) Run(ctx context.Context) (objectcleanup.Result, error) {
	stale, invoked, err := w.service.ReconcileRenderJobs(ctx, ReconcileBatchLimit)
	return objectcleanup.Result{Batches: 1, Claimed: stale, Deleted: invoked}, err
}

var _ objectcleanup.Cycle = ReconcileWorker{}

const ReconcileInterval = 10 * time.Second
