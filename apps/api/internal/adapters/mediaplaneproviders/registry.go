package mediaplaneproviders

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	sfuadapter "github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/turn"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// EpisodeReader loads the Episode whose frozen binding picks the provider.
type EpisodeReader interface {
	GetEpisode(ctx context.Context, tenantID, spaceID, episodeID utilities.ID) (episodes.Episode, error)
}

type Config struct {
	ProcessConfig   runtimeconfig.CloudflareRealtimeConfig
	DefaultProvider spaces.MediaPlaneProvider
	Telemetry       providercontracts.Telemetry
	// ChalkSFU is nil while the own SFU is off, so no Space can reach it.
	ChalkSFU *chalksfu.Fleet
	// ChalkSFUSpaces are the Spaces whose new Episodes may start on the own SFU.
	// Every other Space selecting it starts on Cloudflare.
	ChalkSFUSpaces spaces.ChalkSFUAllowlist
	// ChalkSFUNewEpisodesPaused sends every new Episode to Cloudflare. Live Episodes
	// keep resolving to their own SFU binding.
	ChalkSFUNewEpisodesPaused bool
	// ChalkSFUClientSunset is the instant after which a client that cannot run the
	// own SFU is refused a new Episode in an allowlisted Space, instead of getting
	// Cloudflare. The zero value means never.
	ChalkSFUClientSunset time.Time
	// Now is the clock for the sunset; it defaults to time.Now.
	Now      func() time.Time
	Episodes EpisodeReader
	// Recovery moves a live own-SFU Episode whose node was lost. Without it a lost node
	// only fails the Episode's calls.
	Recovery EpisodeRecovery
}

// EpisodeRecovery is the durable side of whole-Episode recovery.
type EpisodeRecovery interface {
	// LiveParticipants counts the Participants the Episode still holds a place for.
	LiveParticipants(ctx context.Context, tenantID, episodeID utilities.ID) (int, error)
	// Binding reads the stored binding, nil when the Episode has none.
	Binding(ctx context.Context, tenantID, episodeID utilities.ID) (*mediaplane.Binding, error)
	// MoveBinding replaces the Episode's binding with next only while the stored binding is
	// at generation from. When another writer moved it first it returns the stored binding
	// with mediaplane.ErrBindingStale, so the caller follows the winner.
	// The move also records, in the same transaction, a retirement debt for each allocation next
	// owes (next.Retirements()), so a committed move is never without its retires.
	MoveBinding(ctx context.Context, tenantID, episodeID utilities.ID, from int64, next mediaplane.Binding) (mediaplane.Binding, error)
	// RecordRetirementDebts adds the debts, keeping the higher generation of a debt that exists.
	RecordRetirementDebts(ctx context.Context, debts []mediaplane.RetirementDebt) error
	// ClaimRetirementDebts returns up to limit debts that are due and pushes their next attempt
	// out by a bounded backoff, so concurrent workers do not take the same debt.
	ClaimRetirementDebts(ctx context.Context, limit int) ([]mediaplane.RetirementDebt, error)
	// SettleRetirementDebt deletes the debt unless a higher generation was recorded since.
	SettleRetirementDebt(ctx context.Context, debt mediaplane.RetirementDebt) error
	// RetirementBacklog counts the unpaid debts and ages the oldest one.
	RetirementBacklog(ctx context.Context) (count int, oldest time.Duration, err error)
}

type Registry struct {
	processConfig   runtimeconfig.CloudflareRealtimeConfig
	defaultProvider spaces.MediaPlaneProvider
	telemetry       providercontracts.Telemetry
	chalk           *chalksfu.Fleet
	chalkSpaces     spaces.ChalkSFUAllowlist
	chalkPaused     bool
	clientSunset    time.Time
	now             func() time.Time
	episodes        EpisodeReader
	recovery        EpisodeRecovery
	// backlog is what the retirement worker last read; the pointer is shared by the copies of the Registry.
	backlog *backlogCell
	// turn outlives a single Resolve, so TURN credentials are minted once for
	// all joins. It is nil without a TURN key.
	turn *turn.Credentials
}

type providerConfig struct {
	Enabled    *bool             `json:"enabled"`
	Provider   string            `json:"provider"`
	Mode       string            `json:"mode"`
	Cloudflare *cloudflareConfig `json:"cloudflare"`
}

type cloudflareConfig struct {
	AccountID string `json:"account_id"`

	SFU *cloudflareSFUConfig `json:"sfu"`
}

type cloudflareSFUConfig struct {
	AppID     string `json:"app_id"`
	AppSecret string `json:"app_secret"`
}

func NewRegistry(config Config) Registry {
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return Registry{
		clientSunset:    config.ChalkSFUClientSunset,
		now:             now,
		processConfig:   config.ProcessConfig,
		defaultProvider: config.DefaultProvider,
		telemetry:       config.Telemetry,
		chalk:           config.ChalkSFU,
		chalkSpaces:     config.ChalkSFUSpaces,
		chalkPaused:     config.ChalkSFUNewEpisodesPaused,
		episodes:        config.Episodes,
		recovery:        config.Recovery,
		backlog:         &backlogCell{},
		turn:            turn.New(config.ProcessConfig.TurnKeyID, config.ProcessConfig.TurnAPIToken),
	}
}

// ResolveEpisode returns the media plane the Episode is bound to. The Episode's
// binding picks the provider, so a later change to the Space or Tenant selector
// cannot move a live Episode. An Episode whose binding is null started without
// media and has none, unless its selected provider still has no application: then
// it refuses as unavailable, as master does; an Episode with no binding key
// predates the binding and stays on Cloudflare. The Tenant document still supplies the mode and the
// credentials, and the resolved application must match the binding's fingerprint.
func (r Registry) ResolveEpisode(ctx context.Context, tenant tenants.Tenant, space spaces.Space, episodeID utilities.ID) (service *mediaplane.Service, err error) {
	startedAt := time.Now()
	resolution := providercontracts.Resolution{
		ConfigurationSource: providercontracts.ConfigurationSourceNone,
		Mode:                providercontracts.ModeUnknown,
	}
	defer func() {
		resolution.Duration = time.Since(startedAt)
		resolution.Outcome, resolution.FailureClass = resolutionResult(service, err, resolution.ConfigurationSource)
		if r.telemetry != nil {
			r.telemetry.RecordResolution(ctx, resolution)
		}
	}()
	if r.episodes == nil {
		return nil, fmt.Errorf("%w: no episode reader", providercontracts.ErrAdapterUnavailable)
	}
	episode, err := r.episodes.GetEpisode(ctx, tenant.ID, space.ID, episodeID)
	if err != nil {
		return nil, fmt.Errorf("%w: episode lookup failed", mediaplane.ErrPlaneUnavailable)
	}
	binding, legacy, err := episode.MediaPlaneBinding()
	if err != nil {
		return nil, err
	}
	if binding == nil && !legacy {
		// Creation also stores null when the selected provider has no application.
		resolved, err := r.resolveProviderConfig(tenant, space, &resolution, "")
		if err != nil {
			return nil, err
		}
		if resolved != nil && r.applicationID(resolved) == "" {
			return nil, fmt.Errorf("%w: no application for provider %s", providercontracts.ErrAdapterUnavailable, resolution.Provider)
		}
		return nil, nil
	}
	pin := spaces.MediaPlaneProviderCloudflareSFU
	if binding != nil {
		if pin, err = parseSelectedProvider(binding.Provider); err != nil {
			return nil, err
		}
	}
	resolved, err := r.resolveProviderConfig(tenant, space, &resolution, pin)
	if err != nil || resolved == nil {
		return nil, err
	}
	var allocation mediaplane.Allocation
	var generation int64
	if binding != nil {
		fingerprint, err := mediaplane.AdapterFingerprint(binding.Provider, r.applicationID(resolved))
		if err != nil || fingerprint != binding.AdapterFingerprint {
			return nil, fmt.Errorf("%w: the configured application is not the one the Episode was bound to", providercontracts.ErrAdapterUnavailable)
		}
		if episode.Status == episodes.EpisodeStatusActive {
			if *binding, err = r.recoverBinding(ctx, tenant.ID, episodeID, *binding); err != nil {
				return nil, err
			}
		}
		allocation, generation = binding.Current(), binding.Generation
	}
	var fence func(context.Context) error
	if binding != nil {
		fence = r.bindingFence(tenant.ID, episodeID, *binding)
	}
	return r.newService(resolved.provider, resolved.config, allocation, generation, fence)
}

type resolvedProviderConfig struct {
	provider mediaplane.Provider
	config   runtimeconfig.CloudflareRealtimeConfig
}

// resolveProviderConfig finds the provider and its configuration. A non-empty pin
// is the provider of an existing Episode's binding; it replaces the Space and
// Tenant selection and relaxes the Tenant document's provider check, because that
// document describes the next Episode, not this one.
func (r Registry) resolveProviderConfig(tenant tenants.Tenant, space spaces.Space, resolution *providercontracts.Resolution, pin spaces.MediaPlaneProvider) (*resolvedProviderConfig, error) {
	providerName := pin
	if pin == "" {
		selected, err := r.selectedProvider(tenant, space)
		if err != nil {
			return nil, err
		}
		providerName = selected
	}
	resolution.Provider = providerName
	if providerName == "" {
		return nil, nil
	}

	providerConfig, err := parseProviderConfig(tenant.MediaPlaneProviderConfig)
	if err != nil {
		if errors.Is(err, providercontracts.ErrMissingProviderConfig) {
			if providerName != r.defaultProvider && !(providerName == spaces.MediaPlaneProviderChalkSFU && r.chalk != nil) {
				return nil, fmt.Errorf("%w: no process config for provider %s", providercontracts.ErrAdapterUnavailable, providerName)
			}
			resolution.ConfigurationSource = providercontracts.ConfigurationSourceDeploymentDefault
			resolution.Mode = providercontracts.ModeChalkManaged
			provider, providerErr := providerForName(providerName)
			if providerErr != nil {
				return nil, providerErr
			}
			return &resolvedProviderConfig{provider: provider, config: r.processConfig}, nil
		}
		return nil, err
	}
	if providerConfig.Enabled != nil && !*providerConfig.Enabled {
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceDisabled
		resolution.Mode = providercontracts.ModeDisabled
		return nil, nil
	}
	resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantConfiguration

	provider, err := providerForName(providerName)
	if err != nil {
		return nil, err
	}
	mode := strings.TrimSpace(providerConfig.Mode)
	if configuredProvider := strings.TrimSpace(providerConfig.Provider); configuredProvider != "" {
		parsedProvider, parseErr := spaces.ParseMediaPlaneProvider(configuredProvider)
		if parseErr != nil {
			return nil, fmt.Errorf("%w: provider %s", providercontracts.ErrInvalidProviderConfig, configuredProvider)
		}
		// Tenant-managed credentials belong to one provider. In Chalk-managed mode
		// Chalk runs every provider, so the Space selection may pick another one.
		if pin == "" && mode == providercontracts.ModeTenantManaged && parsedProvider != providerName {
			return nil, fmt.Errorf("%w: provider does not match space", providercontracts.ErrInvalidProviderConfig)
		}
	}

	resolution.Mode = mode
	switch mode {
	case providercontracts.ModeChalkManaged:
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantChalkManaged
		return &resolvedProviderConfig{provider: provider, config: r.processConfig}, nil
	case providercontracts.ModeTenantManaged:
		if pin == spaces.MediaPlaneProviderChalkSFU {
			// The Tenant switched to its own Cloudflare credentials after this Episode
			// started on the own SFU. The binding decides where the Episode runs; the
			// document only describes the next one.
			resolution.ConfigurationSource = providercontracts.ConfigurationSourceDeploymentDefault
			resolution.Mode = providercontracts.ModeChalkManaged
			return &resolvedProviderConfig{provider: provider, config: r.processConfig}, nil
		}
		resolution.ConfigurationSource = providercontracts.ConfigurationSourceTenantManaged
		providerConfig, err := r.tenantManagedConfig(providerName, providerConfig)
		if err != nil {
			return nil, err
		}
		return &resolvedProviderConfig{provider: provider, config: providerConfig}, nil
	default:
		return nil, fmt.Errorf("%w: %s", providercontracts.ErrInvalidMode, mode)
	}
}

func resolutionResult(service *mediaplane.Service, err error, source string) (string, string) {
	if err != nil {
		return providercontracts.ResolutionOutcomeError, failureClass(err)
	}
	if source == providercontracts.ConfigurationSourceDisabled {
		return providercontracts.ResolutionOutcomeDisabled, "none"
	}
	if service == nil {
		return providercontracts.ResolutionOutcomeUnconfigured, "none"
	}
	return providercontracts.ResolutionOutcomeResolved, "none"
}

func failureClass(err error) string {
	switch {
	case errors.Is(err, providercontracts.ErrUnknownProvider):
		return "unknown_provider"
	case errors.Is(err, providercontracts.ErrInvalidMode):
		return "invalid_mode"
	case errors.Is(err, providercontracts.ErrMissingProviderConfig):
		return "missing_provider_config"
	case errors.Is(err, providercontracts.ErrInvalidProviderConfig):
		return "invalid_provider_config"
	case errors.Is(err, providercontracts.ErrAdapterUnavailable):
		return "adapter_unavailable"
	default:
		return "unknown"
	}
}

// selectedProvider is the plane the settings choose for a new Episode: the Space,
// then the Tenant, then the platform default. The guards (kill switch, allowlist,
// client capability, node room) apply after it.
func (r Registry) selectedProvider(tenant tenants.Tenant, space spaces.Space) (spaces.MediaPlaneProvider, error) {
	selected, err := spaces.SelectPlane(r.defaultProvider, tenant, space)
	if err != nil {
		return "", fmt.Errorf("%w: %v", providercontracts.ErrUnknownProvider, err)
	}
	return selected, nil
}

// admitsNewChalkSFUEpisode is false while the kill switch is on or the Space is off
// the allowlist: its new Episodes start on Cloudflare.
func (r Registry) admitsNewChalkSFUEpisode(space spaces.Space) bool {
	return !r.chalkPaused && r.chalkSpaces.Allows(space.ID)
}

func parseSelectedProvider(value string) (spaces.MediaPlaneProvider, error) {
	provider, err := spaces.ParseMediaPlaneProvider(value)
	if err != nil {
		return "", fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, strings.TrimSpace(value))
	}
	return provider, nil
}

func parseProviderConfig(raw json.RawMessage) (providerConfig, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return providerConfig{}, providercontracts.ErrMissingProviderConfig
	}

	var config providerConfig
	if err := json.Unmarshal(trimmed, &config); err != nil {
		return providerConfig{}, fmt.Errorf("%w: %v", providercontracts.ErrInvalidProviderConfig, err)
	}
	return config, nil
}

func providerForName(name spaces.MediaPlaneProvider) (mediaplane.Provider, error) {
	switch name {

	case spaces.MediaPlaneProviderCloudflareSFU:
		return mediaplane.ProviderCloudflareSFU, nil
	case spaces.MediaPlaneProviderChalkSFU:
		return mediaplane.ProviderChalkSFU, nil
	default:
		return "", fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, name)
	}
}

func (r Registry) tenantManagedConfig(providerName spaces.MediaPlaneProvider, providerConfig providerConfig) (runtimeconfig.CloudflareRealtimeConfig, error) {
	if providerConfig.Cloudflare == nil {
		return runtimeconfig.CloudflareRealtimeConfig{}, providercontracts.ErrMissingProviderConfig
	}

	if providerName == spaces.MediaPlaneProviderChalkSFU {
		return runtimeconfig.CloudflareRealtimeConfig{}, fmt.Errorf("%w: chalk_sfu has no tenant-managed mode", providercontracts.ErrInvalidMode)
	}

	resolved := runtimeconfig.CloudflareRealtimeConfig{}
	resolved.RequestTimeout = r.processConfig.RequestTimeout
	resolved.RealtimeBaseURL = r.processConfig.RealtimeBaseURL
	resolved.AccountID = providerConfig.Cloudflare.AccountID

	if providerName == spaces.MediaPlaneProviderCloudflareSFU {
		if providerConfig.Cloudflare.SFU == nil {
			return runtimeconfig.CloudflareRealtimeConfig{}, providercontracts.ErrMissingProviderConfig
		}
		resolved.RealtimeAppID = providerConfig.Cloudflare.SFU.AppID
		resolved.RealtimeAppSecret = providerConfig.Cloudflare.SFU.AppSecret
		return resolved, nil
	}

	return runtimeconfig.CloudflareRealtimeConfig{}, fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, providerName)
}

// newService builds the Episode's media plane. allocation is the Episode's bound node and
// boot incarnation for a provider that runs several; a provider with one endpoint ignores it.
func (r Registry) newService(provider mediaplane.Provider, providerConfig runtimeconfig.CloudflareRealtimeConfig, allocation mediaplane.Allocation, generation int64, fence func(context.Context) error) (*mediaplane.Service, error) {
	var plane mediaplane.Plane
	switch provider {

	case mediaplane.ProviderCloudflareSFU:
		configured, err := sfuadapter.NewAdapter(providerConfig)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", providercontracts.ErrAdapterUnavailable, err)
		}
		// Only Chalk's Cloudflare account has a TURN key. Tenant-managed
		// accounts carry none, so their joins use STUN alone.
		if providerConfig.TurnKeyID != "" {
			configured = configured.WithTurnCredentials(r.turn)
		}
		plane = configured
	case mediaplane.ProviderChalkSFU:
		if r.chalk == nil {
			return nil, fmt.Errorf("%w: Chalk SFU is not enabled", providercontracts.ErrAdapterUnavailable)
		}
		bound, err := r.chalk.Node(allocation.Node)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", providercontracts.ErrAdapterUnavailable, err)
		}
		bound = bound.Bound(allocation.Incarnation, generation)
		if fence != nil {
			bound = bound.WithFence(fence)
		}
		// A nil TURN source would be a typed nil inside the interface.
		if r.turn != nil {
			bound = bound.WithRelay(r.turn)
		}
		plane = bound
	default:
		return nil, fmt.Errorf("%w: %s", providercontracts.ErrUnknownProvider, provider)
	}

	service := mediaplane.NewServiceForProvider(provider, plane)
	return &service, nil
}

// applicationID names the provider application a resolved configuration points at.
func (r Registry) applicationID(resolved *resolvedProviderConfig) string {
	switch resolved.provider {
	case mediaplane.ProviderChalkSFU:
		if r.chalk == nil {
			return ""
		}
		return r.chalk.ApplicationID()
	default:
		return strings.TrimSpace(resolved.config.RealtimeAppID)
	}
}

var _ providercontracts.Resolver = Registry{}
