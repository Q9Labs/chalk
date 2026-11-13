package chalksfu_test

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// A pool whose answering nodes are all draining is a planned state, so it gets
// its own reason and is never counted as full. With overflow on the Episode goes
// to Cloudflare; with it off the Episode is refused. A full node next to the
// draining one is still a capacity shortage.
func TestConformanceAnEntirelyDrainingPoolIsNotReportedAsFull(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	draining := startSFUUnder(t, ca, nil)
	full := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-draining", ControlURL: draining.controlURL}, {ID: "sfu-full", ControlURL: full.controlURL}}
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	ctx := context.Background()

	reply, err := draining.httpClient(t, ca, clientIdentity).Post(draining.controlURL+"/v1/drain", "application/json", nil)
	if err != nil || reply.StatusCode != http.StatusOK {
		t.Fatalf("drain: %v, %v", reply, err)
	}
	reply.Body.Close()

	overflowOn := draining.fleetWithOverflow(t, ca, clientIdentity, true, nodes[0])
	overflowOn.Probe(ctx)
	telemetry := &placements{}
	moved, err := registryOn(overflowOn, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || moved.Provider != mediaplane.ProviderCloudflareSFU.SettingName() || moved.Node != "" || moved.PlacementReason != mediaplane.PlacementOverflowDraining {
		t.Fatalf("draining pool, overflow on: %+v, %v, want Cloudflare overflow_draining", moved, err)
	}

	overflowOff := draining.fleetWithOverflow(t, ca, clientIdentity, false, nodes[0])
	overflowOff.Probe(ctx)
	refused, err := registryOn(overflowOff, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if refused != nil || !errors.Is(err, mediaplane.ErrPlacementRefused) {
		t.Fatalf("draining pool, overflow off: %+v, %v, want the placement refusal", refused, err)
	}
	if want := []string{"cf_sfu/overflow_draining", "chalk_sfu/overflow_draining"}; !slices.Equal(telemetry.got, want) {
		t.Fatalf("placement counter saw %v, want %v", telemetry.got, want)
	}

	// Once the other node is full too, a node that takes new Episodes is the
	// reason, so the pool is out of room and not only draining.
	mixed := draining.fleetWithOverflow(t, ca, clientIdentity, true, nodes...)
	fullNode, err := mixed.Node("sfu-full")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, fullNode), scopeOf("ep-1", "alice"))
	mixed.Probe(ctx)
	short, err := registryOn(mixed, withCloudflare, nil, nil).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || short.PlacementReason != mediaplane.PlacementOverflowNoRoom {
		t.Fatalf("draining and full nodes: %+v, %v, want overflow_no_room", short, err)
	}
}

// A node whose host guard refuses new Episodes has packet budget left, so it must
// not be reported as full. A real node cannot be pushed past its guard on demand,
// so this test answers /readyz the way a guarded node does and uses the rest of the
// pool for real.
func TestConformanceAHostGuardRefusalIsNotReportedAsFull(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	real := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	certPEM, keyPEM := ca.issue(t, "localhost", x509.ExtKeyUsageServerAuth)
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	clients := x509.NewCertPool()
	clients.AppendCertsFromPEM(ca.pem)
	guarded := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"protocol":2,"nodeIncarnation":"guarded-1","packetBudget":100000,"reservedPackets":0,"newEpisodePackets":600,"host":{"admissionReason":"cpu_busy"}}`))
	}))
	guarded.TLS = &tls.Config{Certificates: []tls.Certificate{pair}, ClientCAs: clients, ClientAuth: tls.RequireAndVerifyClientCert}
	guarded.StartTLS()
	t.Cleanup(guarded.Close)
	guardedNode := runtimeconfig.ChalkSFUNode{ID: "sfu-guarded", ControlURL: guarded.URL}
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	ctx := context.Background()

	alone := real.fleetWithOverflow(t, ca, clientIdentity, true, guardedNode)
	alone.Probe(ctx)
	telemetry := &placements{}
	moved, err := registryOn(alone, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || moved.Provider != mediaplane.ProviderCloudflareSFU.SettingName() || moved.PlacementReason != mediaplane.PlacementOverflowHostGuard {
		t.Fatalf("guarded pool, overflow on: %+v, %v, want Cloudflare overflow_host_guard", moved, err)
	}
	refusing := real.fleetWithOverflow(t, ca, clientIdentity, false, guardedNode)
	refusing.Probe(ctx)
	if refused, err := registryOn(refusing, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients); refused != nil || !errors.Is(err, mediaplane.ErrPlacementRefused) || !strings.Contains(err.Error(), string(mediaplane.PlacementOverflowHostGuard)) {
		t.Fatalf("guarded pool, overflow off: %+v, %v, want the placement refusal", refused, err)
	}
	if want := []string{"cf_sfu/overflow_host_guard", "chalk_sfu/overflow_host_guard"}; !slices.Equal(telemetry.got, want) {
		t.Fatalf("placement counter saw %v, want %v", telemetry.got, want)
	}

	// A guarded node next to a node out of packet budget is still out of room.
	fullNode := runtimeconfig.ChalkSFUNode{ID: "sfu-full", ControlURL: real.controlURL}
	pool := real.fleetWithOverflow(t, ca, clientIdentity, true, guardedNode, fullNode)
	node, err := pool.Node("sfu-full")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, node), scopeOf("ep-1", "alice"))
	pool.Probe(ctx)
	short, err := registryOn(pool, withCloudflare, nil, nil).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || short.PlacementReason != mediaplane.PlacementOverflowNoRoom {
		t.Fatalf("guarded and full nodes: %+v, %v, want overflow_no_room", short, err)
	}
}

// With the overflow switch off, a new Episode that no node can take is refused
// with the capacity error a full node gives a join, nothing is bound to
// Cloudflare, and an Episode already bound to its node stays there. A Tenant
// without a Cloudflare application keeps today's behavior.
func TestConformanceOverflowOffRefusesTheNewEpisodeAndPinsTheBoundOne(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	box := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-a", ControlURL: box.controlURL}}
	fleet := box.fleetWithOverflow(t, ca, clientIdentity, false, nodes...)
	telemetry := &placements{}
	chalkSpace := spaces.Space{MediaPlane: mediaplane.ProviderChalkSFU.SettingName()}
	ctx := context.Background()

	fleet.Probe(ctx)
	bound, err := registryOn(fleet, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || bound.Node != "sfu-a" || bound.PlacementReason != mediaplane.PlacementPrimary {
		t.Fatalf("pool with room: %+v, %v, want the primary", bound, err)
	}
	node, err := fleet.Node("sfu-a")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, node), scopeOf("ep-1", "alice"))
	fleet.Probe(ctx)

	refused, err := registryOn(fleet, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if refused != nil || !errors.Is(err, mediaplane.ErrPlaneUnavailable) || !errors.Is(err, mediaplane.ErrProviderRateLimited) || !errors.Is(err, mediaplane.ErrPlacementRefused) {
		t.Fatalf("full pool with overflow off: %+v, %v, want the capacity error and no binding", refused, err)
	}
	none, err := registryOn(fleet, runtimeconfig.CloudflareRealtimeConfig{}, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if none != nil || !errors.Is(err, mediaplane.ErrPlacementRefused) {
		t.Fatalf("full pool without a Cloudflare application: %+v, %v, want a refusal and no binding", none, err)
	}
	if want := []string{"chalk_sfu/primary", "chalk_sfu/overflow_no_room", "chalk_sfu/overflow_no_room"}; !slices.Equal(telemetry.got, want) {
		t.Fatalf("placement counter saw %v, want %v", telemetry.got, want)
	}

	// The Episode bound before the pool filled never moves, whatever the pool
	// looks like now, and a binding written before placement records existed
	// still resolves to its node.
	live, err := registryOn(fleet, withCloudflare, bound, nil).ResolveEpisode(ctx, tenants.Tenant{}, chalkSpace, utilities.ID{})
	if err != nil || live.Provider() != mediaplane.ProviderChalkSFU {
		t.Fatalf("bound Episode on a full pool: %v, %v, want chalk_sfu", live, err)
	}
	var legacy mediaplane.Binding
	encoded, err := json.Marshal(map[string]string{
		"schema_version": bound.SchemaVersion, "provider": bound.Provider, "configuration_source": bound.ConfigurationSource,
		"adapter_fingerprint": bound.AdapterFingerprint, "node": bound.Node,
	})
	if err != nil || json.Unmarshal(encoded, &legacy) != nil || legacy.PlacementReason != "" || legacy.NodeIncarnation != "" {
		t.Fatalf("legacy binding %s: %+v, %v", encoded, legacy, err)
	}
	old, err := registryOn(fleet, withCloudflare, &legacy, nil).ResolveEpisode(ctx, tenants.Tenant{}, chalkSpace, utilities.ID{})
	if err != nil || old.Provider() != mediaplane.ProviderChalkSFU {
		t.Fatalf("legacy bound Episode: %v, %v, want chalk_sfu", old, err)
	}
}
