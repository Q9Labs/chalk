package chalksfu_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/turn"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// callFailureCount sums the Chalk SFU failure counter's points that carry every given attribute,
// and fails when a point carries any attribute beyond the bounded set.
func callFailureCount(t *testing.T, reader sdkmetric.Reader, want ...attribute.KeyValue) int64 {
	t.Helper()
	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	bounded := map[attribute.Key]bool{
		"chalk.media_plane.provider": true, "chalk.provider.operation": true, "chalk.provider.failure_stage": true,
		"chalk.provider.transport_cause": true, "http.response.status_class": true,
	}
	var total int64
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "chalk.api.chalk_sfu.failures" {
				continue
			}
			for _, point := range m.Data.(metricdata.Sum[int64]).DataPoints {
				for _, kv := range point.Attributes.ToSlice() {
					if !bounded[kv.Key] {
						t.Fatalf("failure counter carries %q, outside the bounded set", kv.Key)
					}
				}
				matches := true
				for _, kv := range want {
					if got, ok := point.Attributes.Value(kv.Key); !ok || got != kv.Value {
						matches = false
					}
				}
				if matches {
					total += point.Value
				}
			}
		}
	}
	return total
}

// A call to a node that refuses connections reports the cause and nothing of the dial. The Go
// HTTP client's own error text carries the node's control URL and IP, and these errors reach
// the logs of recovery and retirement.
func TestATransportFailureNamesItsCauseAndNeverTheNodeAddress(t *testing.T) {
	reader := turnMetricsReader()
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
	logs := &bytes.Buffer{}
	fleet := box.loggedFleetOf(t, slog.New(slog.NewJSONHandler(logs, nil)), ca, clientIdentity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	bound := placedBinding(t, fleet)
	node, err := url.Parse(box.controlURL)
	if err != nil {
		t.Fatal(err)
	}
	box.stop()
	assertNoAddress := func(what, text string) {
		t.Helper()
		for _, leaked := range []string{box.controlURL, node.Host, node.Hostname(), node.Port(), "dial tcp"} {
			if strings.Contains(text, leaked) {
				t.Fatalf("%s leaks %q: %s", what, leaked, text)
			}
		}
	}
	refused := attribute.String("chalk.provider.transport_cause", "connection_refused")
	before := callFailureCount(t, reader, refused, attribute.String("chalk.provider.operation", "episodes/retire"))

	settled, err := fleet.RetireAllocation(context.Background(), bound.Current(), "tenant-1", "ep-1", 1)
	if settled || !errors.Is(err, mediaplane.ErrProviderFailed) || !strings.Contains(err.Error(), "connection_refused") {
		t.Fatalf("retire on a stopped node: settled %t, %v, want a provider failure that names connection_refused", settled, err)
	}
	assertNoAddress("retire error", err.Error())
	if got := callFailureCount(t, reader, refused, attribute.String("chalk.provider.operation", "episodes/retire")) - before; got != 1 {
		t.Fatalf("failure counter for the retire = %d, want 1 per call, not per attempt", got)
	}

	if _, err := fleet.Recover(context.Background(), chalksfu.LossSilent, bound, "tenant-1", "ep-1", 2); !errors.Is(err, mediaplane.ErrRecoveryRefused) {
		t.Fatalf("recover with a stopped node: %v, want the capacity error", err)
	}
	if !strings.Contains(logs.String(), `"event":"chalk_sfu.recovery"`) || !strings.Contains(logs.String(), "connection_refused") {
		t.Fatalf("recovery log lacks its event or the cause: %s", logs.String())
	}
	assertNoAddress("recovery log", logs.String())
}

// A caller that gives up is not a node failure, so the counter stays flat.
func TestACanceledCallIsNotCountedAsAFailure(t *testing.T) {
	reader := turnMetricsReader()
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, roomy)
	fleet := box.fleetOf(t, ca, clientIdentity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: box.controlURL})
	bound := placedBinding(t, fleet)
	box.stop()
	before := callFailureCount(t, reader)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if settled, err := fleet.RetireAllocation(ctx, bound.Current(), "tenant-1", "ep-1", 1); settled || err == nil {
		t.Fatalf("retire with a canceled context: settled %t, %v, want an error", settled, err)
	}
	if got := callFailureCount(t, reader) - before; got != 0 {
		t.Fatalf("a canceled call counted %d failures, want 0", got)
	}
}

type refusingClient struct{}

func (refusingClient) Do(*http.Request) (*http.Response, error) {
	dial := &net.OpError{Op: "dial", Net: "tcp", Addr: &net.TCPAddr{IP: net.ParseIP("2001:db8::1"), Port: 8080}, Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	return nil, &url.Error{Op: "Post", URL: "https://rtc.live.cloudflare.com/v1/turn/keys/secret-key-id/credentials", Err: dial}
}

// turnRelay is the production TURN source with a client that cannot connect.
type turnRelay struct{ credentials *turn.Credentials }

func (r turnRelay) RelayServers(ctx context.Context) ([]mediaplane.ICEServer, error) {
	return r.credentials.Servers(ctx, refusingClient{}, "https://rtc.live.cloudflare.com/v1")
}

// The join's TURN fallback log names the cause of a failed mint and nothing of the dial.
func TestTheTURNFallbackLogNamesItsCauseAndNeverThePeerAddress(t *testing.T) {
	box := startSFU(t, nil)
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	adapter := box.adapter(t, box.ca, clientIdentity).WithRelay(turnRelay{credentials: turn.New("secret-key-id", "token")})
	if _, err := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, adapter).CreateJoin(context.Background(), mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: scopeOf("ep-turn-leak", "alice"),
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: "ep-turn-leak"},
		ParticipantName: "alice", ExternalParticipantID: "alice", ParticipantPreset: "contributor", AllowRelay: true,
	}); err != nil {
		t.Fatalf("a failed TURN mint must not fail the join: %v", err)
	}
	text := logs.String()
	if !strings.Contains(text, `"event":"chalk_sfu.turn_credentials_failed"`) || !strings.Contains(text, "connection_refused") {
		t.Fatalf("fallback log lacks its event or the cause: %s", text)
	}
	for _, leaked := range []string{"2001:db8", "8080", "dial tcp", "secret-key-id", "cloudflare.com"} {
		if strings.Contains(text, leaked) {
			t.Fatalf("fallback log leaks %q: %s", leaked, text)
		}
	}
}
