package providerbridge

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TrackCloser interface {
	CloseTracks(context.Context, mediaplane.CloseTracksRequest) (mediaplane.CloseTracksResponse, error)
}

// RecordingController owns the Chalk Recording aggregate. The SFU executor
// only dispatches the durable effect; it does not allocate a competing
// Recording identity or perform media capture.
type RecordingController interface {
	Start(context.Context, provideroperations.OperationInput) error
	Stop(context.Context, provideroperations.OperationInput) error
}

const (
	providerCloseFanOut = 8
	// Keep provider closes below Sync's 30 s request timeout to leave time to record closures and respond.
	providerCloseBudget = 20 * time.Second
)

// EpisodeProviders reads the provider and node frozen into an Episode's binding.
// It returns an empty provider for an Episode that predates the binding, which ran
// on Cloudflare, and an empty node for a provider with one endpoint.
type EpisodeProviders interface {
	BindingOf(ctx context.Context, tenantID, episodeID utilities.ID) (provider, node string, generation int64, err error)
}

// ChalkNode is the own SFU node's control surface: it grants and revokes sources,
// closes tracks and ends the Episode's sessions and reservations.
type ChalkNode interface {
	TrackCloser
	EndEpisode(context.Context, mediaplane.EndEpisodeInput) error
	ControlSources(context.Context, mediaplane.ControlSourcesInput) ([]mediaplane.SourceControlResult, error)
}

// ChalkNodes returns the control surface of the SFU node an Episode is bound to, issued under the
// binding's generation, so the node refuses it once the Episode is retired above that generation.
type ChalkNodes func(node string, generation int64) (ChalkNode, error)

// ChalkNodesOf adapts a fleet's per-allocation constructor. It is the one place production builds
// ChalkNodes, so every control and lease renewal names the binding's generation. A failed lookup
// returns a nil ChalkNode, not a typed nil inside the interface.
func ChalkNodesOf[A ChalkNode](allocation func(node string, generation int64) (A, error)) ChalkNodes {
	return func(node string, generation int64) (ChalkNode, error) {
		adapter, err := allocation(node, generation)
		if err != nil {
			return nil, err
		}
		return adapter, nil
	}
}
