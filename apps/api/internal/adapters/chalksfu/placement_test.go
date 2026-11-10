package chalksfu_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	"github.com/q9labs/chalk/apps/api/internal/adapters/mediaplaneproviders"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	providercontracts "github.com/q9labs/chalk/apps/api/internal/mediaplaneproviders"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Two real nodes under one CA, as a production pool runs them: a primary and a
// smaller standby. Placement takes the first node in order that is ready and has
// budget left for a new Episode, and reports no room when none has.
func TestConformancePlacementTakesTheFirstNodeWithRoom(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	// At 200 packets/s per stream pair a new Episode reserves 1,200, so two lone
	// Participants in two Episodes fill the primary's 2,400.
	primary := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "2400"})
	standby := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-standby", ControlURL: standby.controlURL, Role: runtimeconfig.ChalkSFURoleStandby}}
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	ctx := context.Background()
	// Each question gets a fresh pool, because Place charges the Episode it answers with
	// against the node, and this test only asks where the next one would go.
	placeNow := func() (string, bool) {
		asked := primary.fleetOf(t, ca, clientIdentity, nodes...)
		asked.Probe(ctx)
		return place(asked)
	}

	if placed, room := place(fleet); room {
		t.Fatalf("before any probe: placed on %q with room, want no node until the first probe round", placed)
	}
	fleet.Probe(ctx)
	if placed, room := place(fleet); placed != "sfu-primary" || !room {
		t.Fatalf("after the first probe: placed on %q with room %t, want the primary", placed, room)
	}
	if placed, _ := placeNow(); placed != "sfu-primary" {
		t.Fatalf("two nodes with room: placed on %q, want the primary", placed)
	}

	first, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	onPrimary := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, first)
	join(t, onPrimary, scopeOf("ep-1", "alice"))
	if placed, _ := placeNow(); placed != "sfu-primary" {
		t.Fatalf("primary with room for one more Episode: placed on %q, want the primary", placed)
	}
	join(t, onPrimary, scopeOf("ep-2", "bob"))
	if placed, _ := placeNow(); placed != "sfu-standby" {
		t.Fatalf("full primary: placed on %q, want the standby", placed)
	}

	// Calls for an Episode go to its bound node only.
	second, err := fleet.Node("sfu-standby")
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, second), scopeOf("ep-3", "carol"))
	found, err := first.InspectSession(ctx, mediaplane.InspectSessionRequest{ConnectionID: connection, Scope: scopeOf("ep-3", "carol")})
	if err != nil || found.Found {
		t.Fatalf("the standby's session on the primary: %+v, %v, want not found", found, err)
	}
	if placed, room := placeNow(); placed != "" || room {
		t.Fatalf("no node with room: placed on %q with room %t, want no node", placed, room)
	}

	if _, err := fleet.Node("sfu-gone"); err == nil {
		t.Fatal("a node missing from the configuration resolved")
	}
}

// A standby that does not answer never takes an Episode, even with the primary full.
func TestConformancePlacementSkipsASilentNode(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	primary := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-silent", ControlURL: "https://127.0.0.1:" + freePort(t), Role: runtimeconfig.ChalkSFURoleStandby}}
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	first, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, first), scopeOf("ep-1", "alice"))
	fleet.Probe(context.Background())
	if placed, _ := place(fleet); placed != "" {
		t.Fatalf("silent standby, full primary: placed on %q, want no node", placed)
	}
}

// A client without the service identity cannot read readiness, so its probes
// never verify a node and placement offers none.
func TestConformancePlacementNeedsTheServiceIdentity(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	first, second := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"}), startSFUUnder(t, ca, nil)
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-a", ControlURL: first.controlURL}, {ID: "sfu-b", ControlURL: second.controlURL}}
	trusted := first.fleetOf(t, ca, clientIdentity, nodes...)
	nodeA, err := trusted.Node("sfu-a")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, nodeA), scopeOf("ep-busy", "alice"))
	trusted.Probe(context.Background())
	if placed, _ := place(trusted); placed != "sfu-b" {
		t.Fatalf("readable nodes, full first node: placed on %q, want sfu-b", placed)
	}

	stranger := first.fleetOf(t, ca, "someone-else.test", nodes...)
	stranger.Probe(context.Background())
	if placed, room := place(stranger); placed != "" || room {
		t.Fatalf("no readable node: placed on %q with room %t, want no node, as none is verified", placed, room)
	}
}

// A new Episode that every node would refuse starts on Cloudflare before its
// binding is frozen. An Episode already bound to the own SFU never moves.
func TestConformanceAFullPoolStartsTheNewEpisodeOnCloudflare(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	fleet := box.fleet(t)
	fleet.Probe(context.Background())
	chalkSpace := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}
	registry := func(process runtimeconfig.CloudflareRealtimeConfig, live *mediaplane.Binding) mediaplaneproviders.Registry {
		return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
			ProcessConfig: process, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, ChalkSFU: fleet, ChalkSFUSpaces: everySpace, Episodes: episodeBindings{live},
		})
	}
	bound, err := registry(withCloudflare, nil).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || bound.Provider != string(spaces.MediaPlaneProviderChalkSFU) || bound.Node != "sfu-a" {
		t.Fatalf("binding with room: %+v, %v, want chalk_sfu on sfu-a", bound, err)
	}
	node, err := fleet.Node("sfu-a")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, node), scopeOf("ep-1", "alice"))
	fleet.Probe(context.Background())

	next, err := registry(withCloudflare, nil).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || next.Provider != string(spaces.MediaPlaneProviderCloudflareSFU) || next.Node != "" || next.PlacementReason != mediaplane.PlacementOverflowNoRoom {
		t.Fatalf("binding on a full pool: %+v, %v, want Cloudflare", next, err)
	}
	refused, err := registry(runtimeconfig.CloudflareRealtimeConfig{}, nil).ResolveBinding(context.Background(), tenants.Tenant{}, chalkSpace, ownSFUClients)
	if refused != nil || !errors.Is(err, mediaplane.ErrPlacementRefused) {
		t.Fatalf("binding on a full pool without Cloudflare: %+v, %v, want a refusal and no binding", refused, err)
	}
	live, err := registry(withCloudflare, bound).ResolveEpisode(context.Background(), tenants.Tenant{}, chalkSpace, utilities.ID{})
	if err != nil || live.Provider() != mediaplane.ProviderChalkSFU {
		t.Fatalf("Episode bound before the pool filled: %v, %v, want chalk_sfu", live, err)
	}
}

// A draining primary leaves placement and is reported as draining, not as silent. Its live
// Episode keeps taking joins, and an undrain puts it back.
func TestConformanceADrainingNodeLeavesPlacementButKeepsItsEpisode(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	primary := startSFUUnder(t, ca, nil)
	standby := startSFUUnder(t, ca, nil)
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-standby", ControlURL: standby.controlURL, Role: runtimeconfig.ChalkSFURoleStandby}}
	logs := &bytes.Buffer{}
	fleet := primary.loggedFleetOf(t, slog.New(slog.NewTextHandler(logs, nil)), ca, clientIdentity, nodes...)
	ctx := context.Background()
	control := primary.httpClient(t, ca, clientIdentity)
	post := func(path string) {
		t.Helper()
		reply, err := control.Post(primary.controlURL+path, "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		reply.Body.Close()
		if reply.StatusCode != http.StatusOK {
			t.Fatalf("POST %s: status %d", path, reply.StatusCode)
		}
	}

	node, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	onPrimary := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, node)
	join(t, onPrimary, scopeOf("ep-live", "alice"))
	fleet.Probe(ctx)
	if placed, _ := place(fleet); placed != "sfu-primary" {
		t.Fatalf("serving primary: placed on %q, want the primary", placed)
	}
	if health, known := fleet.Health("sfu-primary"); !known || health.Draining || health.Allocations != 1 {
		t.Fatalf("serving primary health %+v known %t, want not draining with 1 allocation", health, known)
	}

	post("/v1/drain")
	for range 3 {
		fleet.Probe(ctx)
	}
	if placed, room := place(fleet); placed != "sfu-standby" || !room {
		t.Fatalf("draining primary: placed on %q with room %t, want the standby", placed, room)
	}
	if health, known := fleet.Health("sfu-primary"); !known || !health.Draining || health.Allocations != 1 || health.CleanupDebt != 0 {
		t.Fatalf("draining primary health %+v known %t, want draining with 1 allocation", health, known)
	}
	if health, known := fleet.Health("sfu-standby"); !known || health.Draining {
		t.Fatalf("serving standby health %+v known %t, want not draining", health, known)
	}
	if got := strings.Count(logs.String(), "chalk sfu node draining"); got != 1 || strings.Contains(logs.String(), "left placement") {
		t.Fatalf("three probes of a draining node logged:\n%s\nwant one draining line and no left-placement line", logs)
	}

	// The live Episode takes a join, a new Episode does not.
	join(t, onPrimary, scopeOf("ep-live", "bob"))
	if _, err := onPrimary.CreateJoin(ctx, mediaplane.CreateJoinInput{
		Provider: mediaplane.ProviderChalkSFU, Scope: scopeOf("ep-new", "carol"),
		Episode:         mediaplane.Episode{Provider: mediaplane.ProviderChalkSFU, Ref: "ep-new"},
		ParticipantName: "carol", ExternalParticipantID: "carol", ParticipantPreset: "contributor",
	}); err == nil {
		t.Fatal("a new Episode joined a draining node")
	}

	post("/v1/undrain")
	fleet.Probe(ctx)
	if placed, _ := place(fleet); placed != "sfu-primary" {
		t.Fatalf("undrained primary: placed on %q, want the primary", placed)
	}
	if health, _ := fleet.Health("sfu-primary"); health.Draining || !strings.Contains(logs.String(), "chalk sfu node no longer draining") {
		t.Fatalf("undrained primary health %+v, logs:\n%s", health, logs)
	}
}

func place(fleet *chalksfu.Fleet) (string, bool) {
	placement, room := fleet.Place()
	return placement.Node, room
}

// placements records the telemetry a Registry reports, in order.
type placements struct{ got []string }

func (p *placements) RecordResolution(context.Context, providercontracts.Resolution) {}

func (p *placements) RecordPlacement(_ context.Context, provider spaces.MediaPlaneProvider, reason mediaplane.PlacementReason) {
	p.got = append(p.got, string(provider)+"/"+string(reason))
}

var withCloudflare = runtimeconfig.CloudflareRealtimeConfig{RealtimeAppID: "deployment-app", RealtimeAppSecret: "secret", RequestTimeout: time.Second}

func registryOn(fleet *chalksfu.Fleet, process runtimeconfig.CloudflareRealtimeConfig, live *mediaplane.Binding, telemetry providercontracts.Telemetry) mediaplaneproviders.Registry {
	return mediaplaneproviders.NewRegistry(mediaplaneproviders.Config{
		ProcessConfig: process, DefaultProvider: spaces.MediaPlaneProviderCloudflareSFU, Telemetry: telemetry, ChalkSFU: fleet, ChalkSFUSpaces: everySpace, Episodes: episodeBindings{live},
	})
}

// A new Episode's binding records why it went where it did: the primary, a
// standby once the primary is full, or Cloudflare once both are, and Cloudflare
// again when no node answers. The placed node's boot incarnation comes from its
// last readiness probe, and every outcome reaches the placement counter.
func TestConformancePlacementRecordsWhyAnEpisodeWentWhereItDid(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	primary := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	standby := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-primary", ControlURL: primary.controlURL}, {ID: "sfu-standby", ControlURL: standby.controlURL, Role: runtimeconfig.ChalkSFURoleStandby}}
	fleet := primary.fleetOf(t, ca, clientIdentity, nodes...)
	telemetry := &placements{}
	registry := registryOn(fleet, withCloudflare, nil, telemetry)
	chalkSpace := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}
	ctx := context.Background()
	resolve := func() mediaplane.Binding {
		t.Helper()
		binding, err := registry.ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
		if err != nil || binding == nil {
			t.Fatalf("binding: %+v, %v", binding, err)
		}
		if err := binding.Validate(); err != nil {
			t.Fatalf("recorded binding is invalid: %v", err)
		}
		return *binding
	}

	// Before the first probe round no node is verified, so the Episode is not bound to one.
	if before := resolve(); before.Provider != string(spaces.MediaPlaneProviderCloudflareSFU) || before.Node != "" || before.PlacementReason != mediaplane.PlacementOverflowNodeUnavailable {
		t.Fatalf("before a probe: %+v, want Cloudflare overflow_node_unavailable", before)
	}

	fleet.Probe(ctx)
	onPrimary := resolve()
	if onPrimary.Provider != string(spaces.MediaPlaneProviderChalkSFU) || onPrimary.Node != "sfu-primary" || onPrimary.PlacementReason != mediaplane.PlacementPrimary || onPrimary.NodeIncarnation == "" {
		t.Fatalf("pool with room: %+v, want the primary with its incarnation", onPrimary)
	}

	first, err := fleet.Node("sfu-primary")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, first), scopeOf("ep-1", "alice"))
	fleet.Probe(ctx)
	onStandby := resolve()
	if onStandby.Node != "sfu-standby" || onStandby.PlacementReason != mediaplane.PlacementStandby || onStandby.NodeIncarnation == "" || onStandby.NodeIncarnation == onPrimary.NodeIncarnation {
		t.Fatalf("full primary: %+v, want the standby with its own incarnation", onStandby)
	}

	second, err := fleet.Node("sfu-standby")
	if err != nil {
		t.Fatal(err)
	}
	join(t, mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, second), scopeOf("ep-2", "bob"))
	fleet.Probe(ctx)
	full := resolve()
	if full.Provider != string(spaces.MediaPlaneProviderCloudflareSFU) || full.Node != "" || full.NodeIncarnation != "" || full.PlacementReason != mediaplane.PlacementOverflowNoRoom {
		t.Fatalf("both nodes full: %+v, want Cloudflare overflow_no_room", full)
	}

	// A client without the service identity reads no node ready.
	stranger := primary.fleetOf(t, ca, "someone-else.test", nodes...)
	stranger.Probe(ctx)
	unavailable := registryOn(stranger, withCloudflare, nil, telemetry)
	down, err := unavailable.ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || down.Provider != string(spaces.MediaPlaneProviderCloudflareSFU) || down.PlacementReason != mediaplane.PlacementOverflowNodeUnavailable {
		t.Fatalf("no node answers: %+v, %v, want Cloudflare overflow_node_unavailable", down, err)
	}

	want := []string{"cf_sfu/overflow_node_unavailable", "chalk_sfu/primary", "chalk_sfu/standby", "cf_sfu/overflow_no_room", "cf_sfu/overflow_node_unavailable"}
	if !slices.Equal(telemetry.got, want) {
		t.Fatalf("placement counter saw %v, want %v", telemetry.got, want)
	}
}

// A pool whose answering nodes are all draining is a planned state, so it gets
// its own reason and is never counted as full. With overflow on the Episode goes
// to Cloudflare; with it off the Episode is refused. A full node next to the
// draining one is still a capacity shortage.
func TestConformanceAnEntirelyDrainingPoolIsNotReportedAsFull(t *testing.T) {
	ca := newAuthority(t, "pool CA")
	draining := startSFUUnder(t, ca, nil)
	full := startSFUUnder(t, ca, map[string]string{"SFU_PACKET_BUDGET": "1200"})
	nodes := []runtimeconfig.ChalkSFUNode{{ID: "sfu-draining", ControlURL: draining.controlURL}, {ID: "sfu-full", ControlURL: full.controlURL}}
	chalkSpace := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}
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
	if err != nil || moved.Provider != string(spaces.MediaPlaneProviderCloudflareSFU) || moved.Node != "" || moved.PlacementReason != mediaplane.PlacementOverflowDraining {
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
	chalkSpace := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}
	ctx := context.Background()

	alone := real.fleetWithOverflow(t, ca, clientIdentity, true, guardedNode)
	alone.Probe(ctx)
	telemetry := &placements{}
	moved, err := registryOn(alone, withCloudflare, nil, telemetry).ResolveBinding(ctx, tenants.Tenant{}, chalkSpace, ownSFUClients)
	if err != nil || moved.Provider != string(spaces.MediaPlaneProviderCloudflareSFU) || moved.PlacementReason != mediaplane.PlacementOverflowHostGuard {
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
	chalkSpace := spaces.Space{MediaPlane: string(spaces.MediaPlaneProviderChalkSFU)}
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
