package mediaplaneproviders

import (
	"context"
	"errors"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

const (
	SpaceProviderCloudflareRTK = string(spaces.MediaPlaneProviderCloudflareRTK)
	SpaceProviderCloudflareSFU = string(spaces.MediaPlaneProviderCloudflareSFU)
	ModeChalkManaged           = "chalk_managed"
	ModeTenantManaged          = "tenant_managed"
	ModeDisabled               = "disabled"
	ModeUnknown                = "unknown"

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
	ErrUnknownProvider       = errors.New("unknown media plane provider")
	ErrInvalidMode           = errors.New("invalid media plane mode")
	ErrMissingProviderConfig = errors.New("missing media plane provider config")
	ErrInvalidProviderConfig = errors.New("invalid media plane provider config")
	ErrAdapterUnavailable    = errors.New("media plane adapter unavailable")
)

type Resolver interface {
	Resolve(context.Context, tenants.Tenant, spaces.Space) (*mediaplane.Service, error)
}

type Resolution struct {
	Provider            spaces.MediaPlaneProvider
	ConfigurationSource string
	Mode                string
	Outcome             string
	FailureClass        string
	Duration            time.Duration
}

type Telemetry interface {
	RecordResolution(context.Context, Resolution)
}
