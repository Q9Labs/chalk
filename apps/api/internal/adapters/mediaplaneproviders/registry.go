package mediaplaneproviders

import (
	"context"
	"fmt"
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
	DefaultProvider mediaplane.Provider
	Telemetry       providercontracts.Telemetry
	// ChalkSFU is nil while the own SFU is off, so no Space can reach it.
	ChalkSFU *chalksfu.Fleet
	// Rollout decides which new Episodes may start on the own SFU. Only a caller that
	// binds new Episodes (ResolveBinding, RefuseClient) needs it.
	Rollout  Rollout
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
	defaultProvider mediaplane.Provider
	telemetry       providercontracts.Telemetry
	chalk           *chalksfu.Fleet
	rollout         Rollout
	episodes        EpisodeReader
	recovery        EpisodeRecovery
	// backlog is what the retirement worker last read; the pointer is shared by the copies of the Registry.
	backlog *backlogCell
	// turn outlives a single Resolve, so TURN credentials are minted once for
	// all joins. It is nil without a TURN key.
	turn *turn.Credentials
}

func NewRegistry(config Config) Registry {
	return Registry{
		rollout:         config.Rollout,
		processConfig:   config.ProcessConfig,
		defaultProvider: config.DefaultProvider,
		telemetry:       config.Telemetry,
		chalk:           config.ChalkSFU,
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
		Mode:                mediaplane.ModeUnknown,
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
	pin := mediaplane.ProviderCloudflareSFU
	if binding != nil {
		if pin, err = binding.ProviderID(); err != nil {
			return nil, fmt.Errorf("%w: %v", providercontracts.ErrUnknownProvider, err)
		}
	}
	resolved, err := r.resolveProviderConfig(tenant, space, &resolution, pin)
	if err != nil || resolved == nil {
		return nil, err
	}
	var allocation mediaplane.Allocation
	var generation int64
	if binding != nil {
		fingerprint, err := mediaplane.AdapterFingerprint(pin, r.applicationID(resolved))
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

// DeploymentBinding is the binding of an Episode that starts on the deployment's
// own application of the provider, such as the one recording capture registers.
func (r Registry) DeploymentBinding(provider mediaplane.Provider) (mediaplane.Binding, error) {
	return mediaplane.NewBinding(provider, mediaplane.BindingSourceDeploymentDefault, r.applicationID(&resolvedProviderConfig{provider: provider, config: r.processConfig}))
}

var _ providercontracts.Resolver = Registry{}
