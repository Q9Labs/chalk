package observability

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
)

// IssueTelemetry passes through: the telemetry credential rides on an access grant that Issue already measures.
func (i AccessGrantIssuer) IssueTelemetry(ctx context.Context, subject accessgrants.Subject) (accessgrants.TelemetryCredential, error) {
	if i.next == nil {
		return accessgrants.TelemetryCredential{}, accessgrants.ErrInvalidConfig
	}
	return i.next.IssueTelemetry(ctx, subject)
}
