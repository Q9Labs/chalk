package mediaplaneproviders

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	ConfigurationSourceDeploymentDefault   = "deployment_default"
	ConfigurationSourceTenantChalkManaged  = "tenant_chalk_managed"
	ConfigurationSourceTenantManaged       = "tenant_managed"
	ConfigurationSourceDisabled            = "disabled"
	ConfigurationSourceTenantConfiguration = "tenant_configuration"
	ConfigurationSourceNone                = "none"

	ResolutionOutcomeResolved     = "resolved"
	ResolutionOutcomeDisabled     = "disabled"
	ResolutionOutcomeUnconfigured = "unconfigured"
	ResolutionOutcomeError        = "error"
)

var (
	ErrUnknownProvider    = errors.New("unknown media plane provider")
	ErrInvalidMode        = errors.New("invalid media plane mode")
	ErrAdapterUnavailable = errors.New("media plane adapter unavailable")
)

type Resolver interface {
	ResolveEpisode(context.Context, tenants.Tenant, spaces.Space, utilities.ID) (*mediaplane.Service, error)
}

type Resolution struct {
	Provider            mediaplane.Provider
	ConfigurationSource string
	Mode                string
	Outcome             string
	FailureClass        string
	Duration            time.Duration
}

type Telemetry interface {
	RecordResolution(context.Context, Resolution)
	// RecordPlacement counts where a new Episode went and why.
	RecordPlacement(context.Context, mediaplane.Provider, mediaplane.PlacementReason)
}
