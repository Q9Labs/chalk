package main

import (
	"errors"
	"math/rand/v2"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

// A burst advances durable transitions without paying the idle poll for each
// node. The cap and minimum spacing bound provider traffic even under churn.
const (
	maxFastFollowSteps     = 32
	fastFollowDelay        = 100 * time.Millisecond
	bootstrapRetryDelay    = time.Second
	maxBootstrapRetrySteps = 60
)

type reconcileCadence struct {
	progressSteps       int
	bootstrapRetrySteps int
	rateLimitDelay      time.Duration
}

func (c *reconcileCadence) nextDelay(interval time.Duration, action recorderfleet.Action, err error) time.Duration {
	var limited *recorderfleet.ProviderRateLimitError
	if errors.As(err, &limited) {
		c.progressSteps, c.bootstrapRetrySteps = 0, 0
		if c.rateLimitDelay == 0 {
			c.rateLimitDelay = 5 * time.Second
		} else {
			c.rateLimitDelay = min(2*c.rateLimitDelay, 5*time.Minute)
		}
		delay := max(interval, c.rateLimitDelay, time.Until(limited.RetryAt))
		jitter := time.Duration(rand.Int64N(int64(c.rateLimitDelay/4) + 1))
		return delay + min(jitter, time.Duration(1<<63-1)-delay)
	}
	c.rateLimitDelay = 0
	if errors.Is(err, recorderfleet.ErrInventoryNotReady) || errors.Is(err, recorderfleet.ErrBootstrapPending) {
		c.progressSteps = 0
		if c.bootstrapRetrySteps < maxBootstrapRetrySteps {
			c.bootstrapRetrySteps++
			return min(interval, bootstrapRetryDelay)
		}
		c.bootstrapRetrySteps = 0
		return interval
	}
	c.bootstrapRetrySteps = 0
	if err != nil || !madeProgress(action) || c.progressSteps >= maxFastFollowSteps {
		c.progressSteps = 0
		return interval
	}
	c.progressSteps++
	return min(interval, fastFollowDelay)
}

func madeProgress(action recorderfleet.Action) bool {
	switch action {
	case recorderfleet.ActionCreatePlanned, recorderfleet.ActionNodeEnsured,
		recorderfleet.ActionBootstrapEnsured, recorderfleet.ActionNodeReady,
		recorderfleet.ActionAdmissionClosed, recorderfleet.ActionIdentityRevoked,
		recorderfleet.ActionNodeDeleted, recorderfleet.ActionMissingNodeReconciled:
		return true
	default:
		return false
	}
}
