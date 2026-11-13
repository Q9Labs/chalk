package chalksfu_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// cancelingRelay gives up the join while TURN credentials are being minted.
type cancelingRelay struct{ cancel context.CancelFunc }

func (c cancelingRelay) RelayServers(ctx context.Context) ([]mediaplane.ICEServer, error) {
	c.cancel()
	return nil, ctx.Err()
}

type fakeRelay struct{ err error }

func (f fakeRelay) RelayServers(context.Context) ([]mediaplane.ICEServer, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []mediaplane.ICEServer{{URLs: []string{"turns:turn.example:443?transport=tcp"}, Username: "u", Credential: "c"}}, nil
}

// The SFU has no TCP media, so a client limited to TCP 443 needs TURN. Only
// joins the caller allows to relay get it, and a TURN failure leaves STUN.
func TestConformanceRelayOnlyForAllowedJoins(t *testing.T) {
	s := startSFU(t, nil)
	iceServers := func(adapter *chalksfu.Adapter, scope mediaplane.Scope, allow bool) []mediaplane.ICEServer {
		t.Helper()
		service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, adapter)
		joined, err := service.CreateJoin(context.Background(), mediaplane.CreateJoinInput{
			Provider: mediaplane.ProviderChalkSFU, Scope: scope,
			Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: scope.EpisodeID},
			ParticipantName: scope.ParticipantID, ExternalParticipantID: scope.ParticipantID, ParticipantPreset: "contributor",
			AllowRelay: allow,
		})
		if err != nil {
			t.Fatalf("join %s: %v", scope.ParticipantID, err)
		}
		servers, _ := joined.ClientPayload["iceServers"].([]mediaplane.ICEServer)
		return servers
	}
	relayed := func(adapter *chalksfu.Adapter, scope mediaplane.Scope, allow bool) bool {
		t.Helper()
		for _, server := range iceServers(adapter, scope, allow) {
			for _, u := range server.URLs {
				if strings.HasPrefix(u, "turns:") {
					return true
				}
			}
		}
		return false
	}
	reader := turnMetricsReader()
	failuresBefore := turnMintFailureCount(t, reader)
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	plain := s.adapter(t, s.ca, clientIdentity)
	withRelay := plain.WithRelay(fakeRelay{})
	if !relayed(withRelay, scopeOf("ep-relay", "allowed"), true) {
		t.Fatal("an allowed join got no TURN server")
	}
	if relayed(withRelay, scopeOf("ep-relay", "denied"), false) {
		t.Fatal("a join that may not relay got a TURN server")
	}
	failing := plain.WithRelay(fakeRelay{err: errors.New("mint failed")})
	fallback := iceServers(failing, scopeOf("ep-relay-fallback", "fallback"), true)
	if len(fallback) == 0 || relayed(failing, scopeOf("ep-relay-fallback", "again"), true) {
		t.Fatalf("a failed mint must leave STUN servers and no TURN server, got %+v", fallback)
	}
	if !strings.Contains(logs.String(), `"event":"chalk_sfu.turn_credentials_failed"`) ||
		!strings.Contains(logs.String(), `"episode_id":"ep-relay-fallback"`) {
		t.Fatalf("mint failure log lacks the event or the Episode id: %s", logs.String())
	}
	if got := turnMintFailureCount(t, reader) - failuresBefore; got != 2 {
		t.Fatalf("turn mint failures = %d, want 2 (one per failed join)", got)
	}
	canceled, cancel := context.WithCancel(context.Background())
	defer cancel()
	abandoned := plain.WithRelay(cancelingRelay{cancel: cancel})
	if _, err := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, abandoned).CreateJoin(canceled, mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: scopeOf("ep-relay-canceled", "canceled"),
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: "ep-relay-canceled"},
		ParticipantName: "canceled", ExternalParticipantID: "canceled", ParticipantPreset: "contributor", AllowRelay: true,
	}); err != nil {
		t.Fatalf("a join abandoned during the TURN mint: %v", err)
	}
	if got := turnMintFailureCount(t, reader) - failuresBefore; got != 2 {
		t.Fatalf("a canceled join counted as a mint failure: %d", got)
	}
}

// The adapter's package-level counter binds to the first global meter provider only,
// so every run in the process shares one reader and tests compare counts by difference.
var turnMetricsReader = sync.OnceValue(func() sdkmetric.Reader {
	reader := sdkmetric.NewManualReader()
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)))
	return reader
})

func turnMintFailureCount(t *testing.T, reader sdkmetric.Reader) int64 {
	t.Helper()
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "chalk.sfu.turn_mint_failures" {
				continue
			}
			for _, point := range m.Data.(metricdata.Sum[int64]).DataPoints {
				if got, _ := point.Attributes.Value("chalk.media_plane.provider"); got.AsString() != "chalk_sfu" || point.Attributes.Len() != 1 {
					t.Fatalf("counter attributes = %v, want only the media plane", point.Attributes)
				}
				total += point.Value
			}
		}
	}
	return total
}
