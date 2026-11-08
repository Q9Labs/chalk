package chalksfu_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const clientIdentity = "chalk-api.test"

var (
	binaryDir  string
	binaryPath string
	buildOnce  sync.Once
	buildErr   error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if binaryDir != "" {
		_ = os.RemoveAll(binaryDir)
	}
	os.Exit(code)
}

// sfuBinary builds the SFU from the repository once. The conformance tests run the
// real service as a process, so they test the wire contract and not a copy of it.
func sfuBinary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		_, file, _, _ := runtime.Caller(0)
		source := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..", "features", "media", "sfu")
		binaryDir, buildErr = os.MkdirTemp("", "chalk-sfu-conformance-")
		if buildErr != nil {
			return
		}
		binaryPath = filepath.Join(binaryDir, "sfu")
		output, err := exec.Command("go", "build", "-C", source, "-o", binaryPath, "./cmd/sfu").CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("build sfu: %w\n%s", err, output)
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return binaryPath
}

type authority struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newAuthority(t *testing.T, name string) *authority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &authority{cert: cert, key: key, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

var serial atomic.Int64

// issue returns a certificate and key in PEM form, valid for one DNS name and loopback.
func (a *authority) issue(t *testing.T, dnsName string, usage x509.ExtKeyUsage) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial.Add(2)), Subject: pkix.Name{CommonName: dnsName},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage},
		DNSNames: []string{dnsName}, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, a.cert, &key.PublicKey, a.key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}

func write(t *testing.T, dir, name string, content []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// sfu is one running service process and the CA that issued its client certificate.
type sfu struct {
	ca         *authority
	controlURL string
	dir        string
	binary     string
	env        []string
	stop       func()
}

func freePort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	return port
}

func startSFU(t *testing.T, settings map[string]string) *sfu {
	t.Helper()
	return startSFUUnder(t, newAuthority(t, "conformance CA"), settings)
}

// startSFUUnder starts a node whose certificates come from ca, so several nodes
// can share one client trust, as a pool's nodes do.
func startSFUUnder(t *testing.T, ca *authority, settings map[string]string) *sfu {
	t.Helper()
	binary := sfuBinary(t)
	dir := t.TempDir()
	serverCert, serverKey := ca.issue(t, "localhost", x509.ExtKeyUsageServerAuth)
	controlPort, udpPort := freePort(t), freePort(t)
	env := append(os.Environ(),
		"SFU_CONTROL_ADDR=127.0.0.1:"+controlPort,
		"SFU_UDP_ADDR=127.0.0.1:"+udpPort,
		"SFU_ANNOUNCE_IPS=127.0.0.1",
		"SFU_ICE_LOOPBACK=true",
		"SFU_TLS_CERT_FILE="+write(t, dir, "server.pem", serverCert),
		"SFU_TLS_KEY_FILE="+write(t, dir, "server.key", serverKey),
		"SFU_CLIENT_CA_FILE="+write(t, dir, "ca.pem", ca.pem),
		"SFU_CLIENT_IDENTITY="+clientIdentity,
		// A source forwards only under a grant. The longest lease outlasts a test that
		// grants once, and a test of lapses sets its own.
		"SFU_SOURCE_LEASE_TTL=2m",
		// One camera per Participant at 150 packets/s a hop, so a stream pair costs 200 and the
		// budget tests below can count in whole pairs. A test sets its own costs after these.
		"SFU_CAMERAS_PER_PARTICIPANT=1",
		"SFU_CAMERA_UPLINK_COST=150",
		"SFU_VIDEO_STREAM_COST=150",
		"SFU_SCREEN_STREAM_COST=150",
		// Every camera reserves the full stream cost however large the call. The node refuses
		// to start when the large-call reservation it would use instead does not fit the small
		// budgets the placement and admission tests count in.
		"SFU_LARGE_CALL_PARTICIPANTS=0",
	)
	for key, value := range settings {
		env = append(env, key+"="+value)
	}
	service := &sfu{ca: ca, controlURL: "https://127.0.0.1:" + controlPort, dir: dir, binary: binary, env: env}
	service.launch(t)
	return service
}

// launch starts the node process and waits until it answers /healthz.
func (s *sfu) launch(t *testing.T) {
	t.Helper()
	command := exec.Command(s.binary)
	command.Env = s.env
	if err := command.Start(); err != nil {
		t.Fatalf("start sfu: %v", err)
	}
	exited := make(chan struct{})
	go func() { _ = command.Wait(); close(exited) }()
	var once sync.Once
	s.stop = func() {
		once.Do(func() {
			_ = command.Process.Signal(syscall.SIGTERM)
			select {
			case <-exited:
			case <-time.After(10 * time.Second):
				_ = command.Process.Kill()
				<-exited
			}
		})
	}
	t.Cleanup(s.stop)
	probe := s.httpClient(t, s.ca, clientIdentity)
	deadline := time.Now().Add(15 * time.Second)
	for {
		response, err := probe.Get(s.controlURL + "/healthz")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		select {
		case <-exited:
			t.Fatal("sfu exited before it was ready")
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("sfu not ready: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *sfu) httpClient(t *testing.T, clientCA *authority, identity string) *http.Client {
	t.Helper()
	certPEM, keyPEM := clientCA.issue(t, identity, x509.ExtKeyUsageClientAuth)
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(s.ca.cert)
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, ServerName: "localhost", Certificates: []tls.Certificate{pair}}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 10 * time.Second}
}

// adapter builds the API's adapter against this service with a client certificate
// from clientCA that names identity.
func (s *sfu) adapter(t *testing.T, clientCA *authority, identity string) *chalksfu.Adapter {
	t.Helper()
	return s.adapterTo(t, clientCA, identity, s.controlURL)
}

// adapterAt points the right client identity at another URL, such as a proxy.
func (s *sfu) adapterAt(t *testing.T, url string) *chalksfu.Adapter {
	t.Helper()
	return s.adapterTo(t, s.ca, clientIdentity, url)
}

func (s *sfu) adapterTo(t *testing.T, clientCA *authority, identity, controlURL string) *chalksfu.Adapter {
	t.Helper()
	fleet := s.fleetOf(t, clientCA, identity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: controlURL})
	adapter, err := fleet.Node("sfu-a")
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

// fleet is a one-node pool on this service with the right client identity.
func (s *sfu) fleet(t *testing.T) *chalksfu.Fleet {
	t.Helper()
	return s.fleetOf(t, s.ca, clientIdentity, runtimeconfig.ChalkSFUNode{ID: "sfu-a", ControlURL: s.controlURL})
}

// fleetOf builds a pool trusting this service's CA with a client certificate
// from clientCA that names identity.
func (s *sfu) fleetOf(t *testing.T, clientCA *authority, identity string, nodes ...runtimeconfig.ChalkSFUNode) *chalksfu.Fleet {
	t.Helper()
	return s.buildFleet(t, nil, clientCA, identity, true, nodes...)
}

// loggedFleetOf is fleetOf with a logger, for tests that read the pool's transitions.
func (s *sfu) loggedFleetOf(t *testing.T, log *slog.Logger, clientCA *authority, identity string, nodes ...runtimeconfig.ChalkSFUNode) *chalksfu.Fleet {
	t.Helper()
	return s.buildFleet(t, log, clientCA, identity, true, nodes...)
}

// fleetWithOverflow is fleetOf with the Cloudflare overflow switch set.
func (s *sfu) fleetWithOverflow(t *testing.T, clientCA *authority, identity string, overflow bool, nodes ...runtimeconfig.ChalkSFUNode) *chalksfu.Fleet {
	t.Helper()
	return s.buildFleet(t, nil, clientCA, identity, overflow, nodes...)
}

func (s *sfu) buildFleet(t *testing.T, log *slog.Logger, clientCA *authority, identity string, overflow bool, nodes ...runtimeconfig.ChalkSFUNode) *chalksfu.Fleet {
	t.Helper()
	certPEM, keyPEM := clientCA.issue(t, identity, x509.ExtKeyUsageClientAuth)
	fleet, err := chalksfu.NewFleet(runtimeconfig.ChalkSFUConfig{
		Enabled: true, ApplicationID: "conformance-pool", CloudflareOverflow: overflow, Nodes: nodes, ServerName: "localhost", STUNURLs: []string{"stun:stun.example:3478"},
		CAFile: write(t, s.dir, "trust.pem", s.ca.pem), ClientCertFile: write(t, s.dir, fmt.Sprintf("client-%d.pem", serial.Add(1)), certPEM),
		ClientKeyFile: write(t, s.dir, fmt.Sprintf("client-%d.key", serial.Load()), keyPEM), RequestTimeout: 10 * time.Second,
	}, log)
	if err != nil {
		t.Fatalf("new fleet: %v", err)
	}
	return fleet
}

// grant grants every source of each Participant at revision 1, as Sync does when it
// lets them publish.
func (s *sfu) grant(t *testing.T, scopes ...mediaplane.Scope) {
	t.Helper()
	adapter := s.adapterAt(t, s.controlURL)
	for _, scope := range scopes {
		var controls []mediaplane.SourceControl
		for _, source := range []string{"microphone", "camera", "screen", "screen_audio"} {
			controls = append(controls, mediaplane.SourceControl{ParticipantID: scope.ParticipantID, Source: source, Action: mediaplane.SourceGrant, Revision: 1})
		}
		if _, err := adapter.ControlSources(context.Background(), mediaplane.ControlSourcesInput{TenantID: scope.TenantID, EpisodeID: scope.EpisodeID, Controls: controls}); err != nil {
			t.Fatalf("grant %s: %v", scope.ParticipantID, err)
		}
	}
}

func (s *sfu) service(t *testing.T) mediaplane.Service {
	t.Helper()
	return mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, s.adapter(t, s.ca, clientIdentity))
}

// peer is a Pion peer connection that talks to the SFU on loopback.
type peer struct {
	pc       *webrtc.PeerConnection
	received atomic.Int64
}

func newPeer(t *testing.T) *peer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	p := &peer{pc: pc}
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, err := remote.ReadRTP(); err != nil {
				return
			}
			p.received.Add(1)
		}
	})
	t.Cleanup(func() { _ = pc.Close() })
	return p
}

func (p *peer) describe(t *testing.T, description webrtc.SessionDescription) mediaplane.SessionDescription {
	t.Helper()
	gathered := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(description); err != nil {
		t.Fatal(err)
	}
	<-gathered
	local := p.pc.LocalDescription()
	return mediaplane.SessionDescription{SDP: local.SDP, Type: local.Type.String()}
}

func (p *peer) offer(t *testing.T) mediaplane.SessionDescription {
	t.Helper()
	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	return p.describe(t, offer)
}

// answer applies the SFU's offer and returns this peer's answer.
func (p *peer) answer(t *testing.T, offer *mediaplane.SessionDescription) mediaplane.SessionDescription {
	t.Helper()
	if offer == nil || offer.Type != "offer" {
		t.Fatalf("expected an SFU offer, got %+v", offer)
	}
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	return p.describe(t, answer)
}

func (p *peer) accept(t *testing.T, answer *mediaplane.SessionDescription) {
	t.Helper()
	if answer == nil || answer.Type != "answer" {
		t.Fatalf("expected an SFU answer, got %+v", answer)
	}
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatal(err)
	}
}

// addAudio adds a microphone track and returns it with its MID once an offer exists.
func (p *peer) addAudio(t *testing.T, id string) *webrtc.TrackLocalStaticRTP {
	t.Helper()
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, id, "peer")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.pc.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	return track
}

func (p *peer) mid(t *testing.T, track *webrtc.TrackLocalStaticRTP) string {
	t.Helper()
	for _, transceiver := range p.pc.GetTransceivers() {
		if sender := transceiver.Sender(); sender != nil && sender.Track() != nil && sender.Track().ID() == track.ID() {
			return transceiver.Mid()
		}
	}
	t.Fatalf("no transceiver for track %s", track.ID())
	return ""
}

// send writes RTP packets until the context ends.
func send(ctx context.Context, track *webrtc.TrackLocalStaticRTP) {
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sequence++
				packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: sequence, Timestamp: uint32(sequence) * 960}, Payload: []byte{1, 2, 3, 4}}
				_ = track.WriteRTP(packet)
			}
		}
	}()
}

func eventually(t *testing.T, what string, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// ownSFUClients is an SDK that runs both providers.
var ownSFUClients = mediaplane.ParseClientProviders("cloudflare_sfu,chalk_sfu")
