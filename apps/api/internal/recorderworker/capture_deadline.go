package recorderworker

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordercapture"
)

// watchDeadline calls expire when the capture's end passes. A later capture plan moves the end,
// so the wait starts over each time it does.
func watchDeadline(ctx context.Context, authority recordercapture.AttemptAuthority, after func(time.Duration) <-chan time.Time, now func() time.Time, expire func()) {
	for {
		armed := authority.EndsAt()
		select {
		case <-after(armed.Sub(now().UTC())):
			if authority.EndsAt().After(armed) {
				continue
			}
			expire()
			return
		case <-authority.DeadlineMoved():
		case <-ctx.Done():
			return
		}
	}
}
