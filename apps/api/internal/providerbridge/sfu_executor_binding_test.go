package providerbridge

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type boundProvider struct {
	name string
	node string
	err  error
}

func (b boundProvider) BindingOf(context.Context, utilities.ID, utilities.ID) (string, string, error) {
	return b.name, b.node, b.err
}

// nodes serves the recorders by node name, like the fleet does.
func nodes(byName map[string]*chalkCleanupRecorder) ChalkNodes {
	if byName == nil {
		return nil
	}
	return func(node string) (ChalkCleanup, error) {
		recorder, ok := byName[node]
		if !ok {
			return nil, errors.New("node is not configured")
		}
		return recorder, nil
	}
}

type chalkCleanupRecorder struct {
	executorTrackCloser
	ended []mediaplane.EndEpisodeInput
}

func (c *chalkCleanupRecorder) EndEpisode(_ context.Context, input mediaplane.EndEpisodeInput) error {
	c.ended = append(c.ended, input)
	return nil
}

// Cleanup closes tracks through the provider frozen into the Episode's binding,
// whatever the Space selects now, and an unknown provider never falls to Cloudflare.
func TestCleanupFollowsTheEpisodeBinding(t *testing.T) {
	tenantID := testExecutorID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := testExecutorID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	publicationID := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"publisher-connection","m":"0","t":"microphone-track","g":1}`))
	revoke := provideroperations.OperationInput{Effect: provideroperations.EffectRevokePublication, TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, PublicationSource: "microphone"}
	run := func(providers EpisodeProviders, chalk *chalkCleanupRecorder, input provideroperations.OperationInput) (ExecutionResult, *executorTrackCloser) {
		registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "microphone", Enabled: true, PublicationID: publicationID}}
		cloudflare := &executorTrackCloser{}
		var byNode ChalkNodes
		if chalk != nil {
			byNode = nodes(map[string]*chalkCleanupRecorder{"sfu-a": chalk})
		}
		return NewSFUExecutor(registry, cloudflare).WithChalkSFU(providers, byNode).Dispatch(context.Background(), input), cloudflare
	}

	t.Run("a legacy Episode with no binding cleans up through Cloudflare", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, cloudflare := run(boundProvider{}, chalk, revoke)
		if result.Outcome != provideroperations.OutcomeConfirmed || cloudflare.calls != 1 || chalk.calls != 0 {
			t.Fatalf("result=%+v cloudflare=%d chalk=%d", result, cloudflare.calls, chalk.calls)
		}
	})

	t.Run("a chalk_sfu Episode cleans up through the own SFU", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, cloudflare := run(boundProvider{name: "chalk_sfu", node: "sfu-a"}, chalk, revoke)
		if result.Outcome != provideroperations.OutcomeConfirmed || cloudflare.calls != 0 || chalk.calls != 1 || !chalk.force {
			t.Fatalf("result=%+v cloudflare=%d chalk=%d", result, cloudflare.calls, chalk.calls)
		}
	})

	t.Run("ending a chalk_sfu Episode ends its sessions", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		end := revoke
		end.Effect = provideroperations.EffectEndEpisode
		_, cloudflare := run(boundProvider{name: "chalk_sfu", node: "sfu-a"}, chalk, end)
		if len(chalk.ended) != 1 || chalk.ended[0].Provider != mediaplane.ProviderChalkSFU || chalk.ended[0].EpisodeRef != episodeID.String() || cloudflare.calls != 0 {
			t.Fatalf("ended=%+v cloudflare=%d", chalk.ended, cloudflare.calls)
		}
	})

	t.Run("a chalk_sfu Episode retries when the own SFU is off", func(t *testing.T) {
		result, cloudflare := run(boundProvider{name: "chalk_sfu", node: "sfu-a"}, nil, revoke)
		if result.Outcome != provideroperations.OutcomeRetryableFailure || cloudflare.calls != 0 {
			t.Fatalf("result=%+v cloudflare=%d", result, cloudflare.calls)
		}
	})

	t.Run("a chalk_sfu Episode cleans up on its bound node only", func(t *testing.T) {
		first, second := &chalkCleanupRecorder{}, &chalkCleanupRecorder{}
		registry := &executorPublicationRegistry{publication: provideroperations.Publication{ParticipantID: participantID, Source: "microphone", Enabled: true, PublicationID: publicationID}}
		executor := NewSFUExecutor(registry, &executorTrackCloser{}).WithChalkSFU(boundProvider{name: "chalk_sfu", node: "sfu-b"}, nodes(map[string]*chalkCleanupRecorder{"sfu-a": first, "sfu-b": second}))
		result := executor.Dispatch(context.Background(), revoke)
		if result.Outcome != provideroperations.OutcomeConfirmed || first.calls != 0 || second.calls != 1 {
			t.Fatalf("result=%+v sfu-a=%d sfu-b=%d", result, first.calls, second.calls)
		}
	})

	t.Run("a chalk_sfu Episode on a node this process lacks retries and touches nothing", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, cloudflare := run(boundProvider{name: "chalk_sfu", node: "sfu-gone"}, chalk, revoke)
		if result.Outcome != provideroperations.OutcomeRetryableFailure || cloudflare.calls != 0 || chalk.calls != 0 {
			t.Fatalf("result=%+v cloudflare=%d chalk=%d", result, cloudflare.calls, chalk.calls)
		}
	})

	t.Run("an unknown provider fails terminally and touches nothing", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, cloudflare := run(boundProvider{name: "future_sfu"}, chalk, revoke)
		if result.Outcome != provideroperations.OutcomeTerminalFailure || cloudflare.calls != 0 || chalk.calls != 0 {
			t.Fatalf("result=%+v cloudflare=%d chalk=%d", result, cloudflare.calls, chalk.calls)
		}
	})

	t.Run("an unreadable binding retries", func(t *testing.T) {
		result, cloudflare := run(boundProvider{err: errors.New("database down")}, &chalkCleanupRecorder{}, revoke)
		if result.Outcome != provideroperations.OutcomeRetryableFailure || cloudflare.calls != 0 {
			t.Fatalf("result=%+v cloudflare=%d", result, cloudflare.calls)
		}
	})
}
