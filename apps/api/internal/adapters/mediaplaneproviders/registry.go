package mediaplaneproviders

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
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
	TURN      runtimeconfig.CloudflareTURNConfig
	Telemetry providercontracts.Telemetry
	// ChalkSFU is nil while the Chalk SFU is off, so no Space can reach it.
	ChalkSFU *chalksfu.Fleet
	// Rollout decides which new Episodes may start on the Chalk SFU. Only a caller that
	// binds new Episodes (ResolveBinding, RefuseClient) needs it.
	Rollout  Rollout
	Episodes EpisodeReader
	// Recovery moves a live Chalk SFU Episode whose node was lost. Without it a lost node
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
	telemetry providercontracts.Telemetry
	chalk     *chalksfu.Fleet
	rollout   Rollout
	episodes  EpisodeReader
	recovery  EpisodeRecovery
	// backlog is what the retirement worker last read; the pointer is shared by the copies of the Registry.
	backlog *backlogCell
	// turn outlives a single Resolve, so TURN credentials are minted once for
	// all joins. It is nil without a TURN key.
	turn *turn.Credentials
}

func NewRegistry(config Config) Registry {
	return Registry{
		rollout:   config.Rollout,
		telemetry: config.Telemetry,
		chalk:     config.ChalkSFU,
		episodes:  config.Episodes,
		recovery:  config.Recovery,
		backlog:   &backlogCell{},
		turn:      turn.New(config.TURN.TurnKeyID, config.TURN.TurnAPIToken),
	}
}

// ResolveEpisode only serves the SFU allocation frozen on the Episode.
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
	binding, _, err := episode.MediaPlaneBinding()
	if err != nil {
		return nil, err
	}
	if binding == nil {
		return nil, nil
	}
	if binding.Provider != mediaplane.ProviderChalkSFU.SettingName() || r.chalk == nil {
		return nil, fmt.Errorf("%w: the Episode's media allocation is unavailable", providercontracts.ErrAdapterUnavailable)
	}
	resolution.Provider = mediaplane.ProviderChalkSFU
	resolution.ConfigurationSource = binding.ConfigurationSource
	resolution.Mode = mediaplane.ModeChalkManaged
	fingerprint, err := mediaplane.AdapterFingerprint(mediaplane.ProviderChalkSFU, r.chalk.ApplicationID())
	if err != nil || fingerprint != binding.AdapterFingerprint {
		return nil, fmt.Errorf("%w: the configured application is not the one the Episode was bound to", providercontracts.ErrAdapterUnavailable)
	}
	if episode.Status == episodes.EpisodeStatusActive {
		if *binding, err = r.recoverBinding(ctx, tenant.ID, episodeID, *binding); err != nil {
			return nil, err
		}
	}
	node, err := r.chalk.Node(binding.Current().Node)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", providercontracts.ErrAdapterUnavailable, err)
	}
	node = node.Bound(binding.Current().Incarnation, binding.Generation).WithFence(r.bindingFence(tenant.ID, episodeID, *binding))
	if r.turn != nil {
		node = node.WithRelay(r.turn)
	}
	resolved := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, node)
	return &resolved, nil
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
	case errors.Is(err, mediaplane.ErrMissingTenantConfig):
		return "missing_provider_config"
	case errors.Is(err, mediaplane.ErrInvalidTenantConfig):
		return "invalid_provider_config"
	case errors.Is(err, providercontracts.ErrAdapterUnavailable):
		return "adapter_unavailable"
	default:
		return "unknown"
	}
}

// DeploymentBinding identifies the fleet for both Episode placement and capture.
func (r Registry) DeploymentBinding() (mediaplane.Binding, error) {
	if r.chalk == nil {
		return mediaplane.Binding{}, providercontracts.ErrAdapterUnavailable
	}
	return mediaplane.NewBinding(mediaplane.ProviderChalkSFU, mediaplane.BindingSourceDeploymentDefault, r.chalk.ApplicationID())
}

var _ providercontracts.Resolver = Registry{}
