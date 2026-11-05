package providerbridge

import (
	"context"
	"encoding/base64"
	"slices"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

// Grants and revokes reach the own SFU as revision-ordered source controls, so a
// host stop fences the source even before any track exists, and a delayed control
// never undoes a newer one. Cloudflare Episodes keep their track-based path.
func TestSourceControlsFollowTheDurableOperation(t *testing.T) {
	tenantID := testExecutorID(t, "11111111-1111-4111-8111-111111111111")
	episodeID := testExecutorID(t, "22222222-2222-4222-8222-222222222222")
	participantID := testExecutorID(t, "33333333-3333-4333-8333-333333333333")
	screenPublication := "chalk_pub_v1." + base64.RawURLEncoding.EncodeToString([]byte(`{"c":"publisher-connection","m":"2","t":"screen-track","g":1}`))
	operation := func(effect provideroperations.Effect, source string, revision int64) provideroperations.OperationInput {
		return provideroperations.OperationInput{Effect: effect, TenantID: tenantID, EpisodeID: episodeID, ParticipantID: participantID, ParticipantGeneration: 1, PublicationSource: source, ControlRevision: revision}
	}
	chalkBound := boundProvider{name: "chalk_sfu", node: "sfu-a"}
	run := func(providers EpisodeProviders, chalk *chalkCleanupRecorder, published provideroperations.Publication, input provideroperations.OperationInput) (ExecutionResult, *executorTrackCloser, *executorPublicationRegistry) {
		cloudflare := &executorTrackCloser{}
		registry := &executorPublicationRegistry{publication: published}
		executor := NewSFUExecutor(registry, cloudflare).WithChalkSFU(providers, nodes(map[string]*chalkCleanupRecorder{"sfu-a": chalk}))
		return executor.Dispatch(context.Background(), input), cloudflare, registry
	}
	want := func(t *testing.T, got []mediaplane.SourceControl, action mediaplane.SourceAction, revision int64, sources ...string) {
		t.Helper()
		names := make([]string, 0, len(got))
		for _, control := range got {
			if control.Action != action || control.Revision != revision || control.ParticipantID != participantID.String() {
				t.Fatalf("control = %+v, want %s at %d", control, action, revision)
			}
			names = append(names, control.Source)
		}
		if !slices.Equal(names, sources) {
			t.Fatalf("sources = %v, want %v", names, sources)
		}
	}

	t.Run("a grant reaches the bound node at its revision", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, _, _ := run(chalkBound, chalk, provideroperations.Publication{}, operation(provideroperations.EffectGrantPublication, "camera", 7))
		if result.Outcome != provideroperations.OutcomeConfirmed {
			t.Fatalf("result = %+v", result)
		}
		want(t, chalk.controls, mediaplane.SourceGrant, 7, "camera")
	})

	t.Run("a screen grant also grants its tab audio", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		run(chalkBound, chalk, provideroperations.Publication{}, operation(provideroperations.EffectGrantPublication, "screen", 9))
		want(t, chalk.controls, mediaplane.SourceGrant, 9, "screen", "screen_audio")
	})

	t.Run("a grant without a revision cannot be ordered and fails", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, _, _ := run(chalkBound, chalk, provideroperations.Publication{}, operation(provideroperations.EffectGrantPublication, "camera", 0))
		if result.Outcome != provideroperations.OutcomeTerminalFailure || result.Reason != "control_revision_required" || len(chalk.controls) != 0 {
			t.Fatalf("result = %+v controls = %+v", result, chalk.controls)
		}
	})

	t.Run("a grant a newer revoke holds is not reported as done", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{stale: true}
		result, _, _ := run(chalkBound, chalk, provideroperations.Publication{}, operation(provideroperations.EffectGrantPublication, "camera", 3))
		if result.Outcome != provideroperations.OutcomeTerminalFailure || result.Reason != "source_revoked" {
			t.Fatalf("result = %+v", result)
		}
	})

	t.Run("a Cloudflare grant stays a no-op", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, cloudflare, _ := run(boundProvider{}, chalk, provideroperations.Publication{}, operation(provideroperations.EffectGrantPublication, "camera", 7))
		if result.Outcome != provideroperations.OutcomeConfirmed || len(chalk.controls) != 0 || cloudflare.calls != 0 {
			t.Fatalf("result = %+v controls = %+v cloudflare = %d", result, chalk.controls, cloudflare.calls)
		}
	})

	t.Run("a revoke with no track still fences the source", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, _, _ := run(chalkBound, chalk, provideroperations.Publication{}, operation(provideroperations.EffectRevokePublication, "microphone", 5))
		if result.Outcome != provideroperations.OutcomeConfirmed || chalk.calls != 0 {
			t.Fatalf("result = %+v closes = %d", result, chalk.calls)
		}
		want(t, chalk.controls, mediaplane.SourceRevoke, 5, "microphone")
	})

	t.Run("a screen revoke fences tab audio and records the track the node closed", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{closed: []mediaplane.ClosedSourceTrack{{ConnectionID: "publisher-connection", MID: "2"}}}
		screen := provideroperations.Publication{ParticipantID: participantID, Source: "screen", Enabled: true, PublicationID: screenPublication}
		result, _, registry := run(chalkBound, chalk, screen, operation(provideroperations.EffectRevokePublication, "screen", 6))
		if result.Outcome != provideroperations.OutcomeConfirmed || chalk.calls != 0 || registry.publication.PublicationID != "" {
			t.Fatalf("result = %+v closes = %d publication = %+v", result, chalk.calls, registry.publication)
		}
		want(t, chalk.controls, mediaplane.SourceRevoke, 6, "screen", "screen_audio")
	})

	// After revoke@6 applies, an overlapping retry can release the fence and grant@7 can
	// admit a new track before this execution reads the publications. The node keeps that
	// track open, and the executor must not close it behind the node's back.
	t.Run("a revoke leaves open a track a newer grant admitted", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		screen := provideroperations.Publication{ParticipantID: participantID, Source: "screen", Enabled: true, PublicationID: screenPublication}
		result, _, registry := run(chalkBound, chalk, screen, operation(provideroperations.EffectRevokePublication, "screen", 6))
		if result.Outcome != provideroperations.OutcomeConfirmed || chalk.calls != 0 || registry.publication.PublicationID != screenPublication {
			t.Fatalf("result = %+v closes = %d publication = %+v", result, chalk.calls, registry.publication)
		}
	})

	t.Run("a revoke a newer grant superseded leaves its publication alone", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{stale: true}
		screen := provideroperations.Publication{ParticipantID: participantID, Source: "screen", Enabled: true, PublicationID: screenPublication}
		result, _, _ := run(chalkBound, chalk, screen, operation(provideroperations.EffectRevokePublication, "screen", 6))
		if result.Outcome != provideroperations.OutcomeSatisfied || chalk.calls != 0 {
			t.Fatalf("result = %+v closes = %d", result, chalk.calls)
		}
	})

	t.Run("removing a Participant fences every source", func(t *testing.T) {
		chalk := &chalkCleanupRecorder{}
		result, _, _ := run(chalkBound, chalk, provideroperations.Publication{}, operation(provideroperations.EffectRemoveParticipant, "", 8))
		if result.Outcome != provideroperations.OutcomeConfirmed {
			t.Fatalf("result = %+v", result)
		}
		want(t, chalk.controls, mediaplane.SourceRevoke, 8, "microphone", "camera", "screen", "screen_audio")
	})
}
