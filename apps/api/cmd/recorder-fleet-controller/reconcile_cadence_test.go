package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"testing/synctest"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func TestRunLoopFastFollowsProgressButWaitsForIdleAndErrors(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		runner := &timedReconciler{
			cancel: cancel,
			steps: []reconcileStep{
				{action: recorderfleet.ActionCreatePlanned},
				{action: recorderfleet.ActionNodeEnsured},
				{action: recorderfleet.ActionDrainWaiting},
				{action: recorderfleet.ActionCreatePlanned, err: errors.New("provider rate limited")},
				{action: recorderfleet.ActionCapacityPublished},
				{action: recorderfleet.ActionNone},
			},
		}
		interval := 5 * time.Second
		if err := runLoop(ctx, interval, runner, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
			t.Fatal(err)
		}
		for index, want := range []time.Duration{fastFollowDelay, fastFollowDelay, interval, interval, interval} {
			if got := runner.times[index+1].Sub(runner.times[index]); got != want {
				t.Fatalf("delay after reconciliation %d = %s, want %s", index+1, got, want)
			}
		}
	})
}

func TestRunLoopBoundsContinuousProgress(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		runner := &timedReconciler{cancel: cancel}
		for range maxFastFollowSteps + 3 {
			runner.steps = append(runner.steps, reconcileStep{action: recorderfleet.ActionNodeEnsured})
		}
		interval := 5 * time.Second
		if err := runLoop(ctx, interval, runner, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
			t.Fatal(err)
		}
		if got := runner.times[maxFastFollowSteps+1].Sub(runner.times[maxFastFollowSteps]); got != interval {
			t.Fatalf("exhausted burst delay = %s, want %s", got, interval)
		}
		if got := runner.times[maxFastFollowSteps+2].Sub(runner.times[maxFastFollowSteps+1]); got != fastFollowDelay {
			t.Fatalf("new burst delay = %s, want %s", got, fastFollowDelay)
		}
	})
}

type reconcileStep struct {
	action recorderfleet.Action
	err    error
}

type timedReconciler struct {
	cancel context.CancelFunc
	steps  []reconcileStep
	times  []time.Time
}

func (r *timedReconciler) Reconcile(context.Context) (recorderfleet.Result, error) {
	step := r.steps[len(r.times)]
	r.times = append(r.times, time.Now())
	if len(r.times) == len(r.steps) {
		r.cancel()
	}
	return recorderfleet.Result{Action: step.action}, step.err
}

func TestRunLoopRetriesPendingBootstrapInOneSecondAndStopsBurst(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		runner := &timedReconciler{cancel: cancel, steps: []reconcileStep{
			{err: fmt.Errorf("ensure bootstrap: %w", recorderfleet.ErrInventoryNotReady)},
			{err: fmt.Errorf("ensure bootstrap: %w", recorderfleet.ErrBootstrapPending)},
			{action: recorderfleet.ActionBootstrapEnsured},
			{err: recorderfleet.ErrProviderUnavailable},
			{err: recorderfleet.ErrRoleFence},
			{err: recorderfleet.ErrInventoryDrift},
			{action: recorderfleet.ActionNone},
		}}
		interval := 7 * time.Second
		if err := runLoop(ctx, interval, runner, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
			t.Fatal(err)
		}
		for index, want := range []time.Duration{time.Second, time.Second, fastFollowDelay, interval, interval, interval} {
			if got := runner.times[index+1].Sub(runner.times[index]); got != want {
				t.Fatalf("delay %d = %s, want %s", index, got, want)
			}
		}
	})
}

func TestPendingBootstrapRetryBurstIsBoundedAndResetsOnRecovery(t *testing.T) {
	var cadence reconcileCadence
	interval := 7 * time.Second
	for attempt := range 65 {
		want := time.Second
		if attempt == 60 {
			want = interval
		}
		if got := cadence.nextDelay(interval, recorderfleet.ActionNone, recorderfleet.ErrBootstrapPending); got != want {
			t.Fatalf("attempt %d delay = %s, want %s", attempt, got, want)
		}
	}
	cadence.nextDelay(interval, recorderfleet.ActionBootstrapEnsured, nil)
	if got := cadence.nextDelay(interval, recorderfleet.ActionNone, recorderfleet.ErrInventoryNotReady); got != time.Second {
		t.Fatalf("recovery did not reset retry burst: %s", got)
	}
	if got := cadence.nextDelay(interval, recorderfleet.ActionNone, recorderfleet.ErrProviderUnavailable); got != interval {
		t.Fatalf("real failure delay = %s", got)
	}
}
