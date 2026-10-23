package digitalocean

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

// RequestBudget is shared by every provider path in a process. The capture
// controller, render controller, and issuer each reserve 1,200 requests/hour
// from the token's 5,000/hour limit. Both issuer roles use the same budget.
type RequestBudget struct {
	gate          chan struct{}
	interval      time.Duration
	nextRequestAt time.Time
	retryAt       time.Time
}

func NewRequestBudget() *RequestBudget {
	return &RequestBudget{gate: make(chan struct{}, 1), interval: 3 * time.Second}
}

func (b *RequestBudget) wait(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if b.retryAt.After(time.Now()) {
		return &recorderfleet.ProviderRateLimitError{RetryAt: b.retryAt}
	}
	if delay := time.Until(b.nextRequestAt); delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	b.nextRequestAt = time.Now().Add(b.interval)
	return nil
}

func maxTime(left, right time.Time) time.Time {
	if right.After(left) {
		return right
	}
	return left
}
