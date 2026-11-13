package chalksfu_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

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

// sfu is one running service process and the CA that issued its client certificate.
type sfu struct {
	ca         *authority
	controlURL string
	dir        string
	binary     string
	env        []string
	stop       func()
	// release frees the ports reserved for the first start. Only launch calls it,
	// just before the process starts; a restart reuses the same ports unreserved.
	release func()
}

// freePort returns a loopback TCP port nothing listens on, for a node that must look down.
func freePort(t *testing.T) string {
	t.Helper()
	port, release := reservePort(t, "tcp4")
	release()
	return port
}

// reservePort holds a free loopback port on network ("tcp4" or "udp4") until release
// runs. A UDP port is reserved on UDP because another process can hold it while its
// TCP twin stays free.
func reservePort(t *testing.T, network string) (port string, release func()) {
	t.Helper()
	var addr net.Addr
	switch network {
	case "tcp4":
		listener, err := net.Listen(network, "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr, release = listener.Addr(), func() { _ = listener.Close() }
	case "udp4":
		conn, err := net.ListenPacket(network, "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr, release = conn.LocalAddr(), func() { _ = conn.Close() }
	default:
		t.Fatalf("reserve port: unsupported network %q", network)
	}
	_, port, _ = net.SplitHostPort(addr.String())
	return port, release
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
	controlPort, releaseControl := reservePort(t, "tcp4")
	udpPort, releaseUDP := reservePort(t, "udp4")
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
	service := &sfu{ca: ca, controlURL: "https://127.0.0.1:" + controlPort, dir: dir, binary: binary, env: env,
		release: func() { releaseControl(); releaseUDP() }}
	service.launch(t)
	return service
}

// launch starts the node process and waits until it answers /healthz.
func (s *sfu) launch(t *testing.T) {
	t.Helper()
	command := exec.Command(s.binary)
	command.Env = s.env
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if s.release != nil {
		s.release()
		s.release = nil
	}
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
			t.Fatalf("sfu exited before it was ready: %s", tail(stderr.String(), 2000))
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("sfu not ready: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// tail keeps the last n bytes of text, where a process says why it stopped.
func tail(text string, n int) string {
	text = strings.TrimSpace(text)
	if len(text) > n {
		return text[len(text)-n:]
	}
	return text
}

// ownSFUClients is an SDK that runs both providers.
var ownSFUClients = mediaplane.ParseClientProviders("cloudflare_sfu,chalk_sfu")
