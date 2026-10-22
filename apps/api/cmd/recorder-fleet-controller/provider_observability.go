package main

import (
	"context"
	"log/slog"

	"github.com/q9labs/chalk/apps/api/internal/adapters/digitalocean"
	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

type observedReconciler struct {
	runner   reconcileRunner
	provider *digitalocean.RecorderFleet
	logger   *slog.Logger
	key      recorderfleet.PoolKey
}

func (r observedReconciler) Reconcile(ctx context.Context) (recorderfleet.Result, error) {
	before := r.provider.RateLimitSnapshot()
	result, err := r.runner.Reconcile(ctx)
	after := r.provider.RateLimitSnapshot()
	r.logger.InfoContext(ctx, "recorder fleet provider budget",
		"environment", r.key.Environment,
		"role", r.key.Role,
		"provider_requests", after.Requests-before.Requests,
		"rate_limit_remaining", after.Remaining,
		"rate_limit_limit", after.Limit,
		"rate_limit_reset", after.ResetAt,
		"rate_limit_observed_at", after.ObservedAt,
	)
	return result, err
}
