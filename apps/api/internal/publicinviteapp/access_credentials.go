package publicinviteapp

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/observability"
)

// MediaIssuer issues the media and telemetry credentials a public access grant carries.
type MediaIssuer interface {
	Issue(context.Context, accessgrants.Subject) (accessgrants.MediaCredential, error)
	IssueTelemetry(context.Context, accessgrants.Subject) (accessgrants.TelemetryCredential, error)
}

func issueGrantCredentials(ctx context.Context, issuer MediaIssuer, clients mediaplane.ClientProviders, subject accessgrants.Subject) (accessgrants.MediaCredential, accessgrants.TelemetryCredential, error) {
	media, err := issuer.Issue(observability.ContextWithAccessGrantClientProviders(ctx, clients), subject)
	if err != nil {
		return accessgrants.MediaCredential{}, accessgrants.TelemetryCredential{}, err
	}
	telemetry, err := issuer.IssueTelemetry(ctx, subject)
	if err != nil {
		return accessgrants.MediaCredential{}, accessgrants.TelemetryCredential{}, err
	}
	return media, telemetry, nil
}
