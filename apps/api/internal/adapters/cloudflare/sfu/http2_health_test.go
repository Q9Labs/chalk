package sfu

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
)

const (
	http2HealthRequestTimeout  = 2 * time.Second
	http2HealthPollInterval    = time.Second
	http2HealthRecoveryTimeout = 15 * time.Second
	http2HealthFaultWindow     = 3 * time.Second
	http2HealthIdleWait        = 16 * time.Second
)

type http2HealthProxy struct {
	listener   net.Listener
	upstream   string
	acceptDone chan struct{}

	mu    sync.Mutex
	fault bool
	links map[*http2HealthLink]struct{}
	pumps sync.WaitGroup
}

type http2HealthLink struct {
	client    net.Conn
	upstream  net.Conn
	dead      bool
	closeOnce sync.Once
}

type http2HealthResult struct {
	attempt   int
	startedAt time.Time
	err       error
}

func TestAdapterRecoversAfterDeadHTTP2Connection(t *testing.T) {
	t.Run("mid-use", func(t *testing.T) {
		adapter, proxy, protocol := newHTTP2HealthAdapter(t)
		assertInitialHTTP2Request(t, adapter, protocol)

		proxy.blackhole()
		time.Sleep(http2HealthFaultWindow)
		proxy.endFault()

		waitForHTTP2HealthRecovery(t, adapter)
	})

	t.Run("idle", func(t *testing.T) {
		adapter, proxy, protocol := newHTTP2HealthAdapter(t)
		assertInitialHTTP2Request(t, adapter, protocol)

		proxy.blackhole()
		time.Sleep(http2HealthFaultWindow)
		proxy.endFault()

		idleStarted := time.Now()
		time.Sleep(http2HealthIdleWait)
		requestStarted := time.Now()
		if _, err := adapter.VerifyConnectionMetadata(context.Background(), "connection"); err != nil {
			t.Fatalf("first request after %s of idle failed: %v", time.Since(idleStarted), err)
		}
		t.Logf("first request succeeded on the first attempt after %s of idle; request duration=%s", time.Since(idleStarted), time.Since(requestStarted))
	})
}

func newHTTP2HealthAdapter(t *testing.T) (Adapter, *http2HealthProxy, *atomic.Int32) {
	t.Helper()
	endpoint, roots, protocol, proxy := newHTTP2HealthServer(t)
	adapter, err := NewAdapter(config.CloudflareRealtimeConfig{
		RealtimeAppID:     "test-app",
		RealtimeAppSecret: "test-secret",
		RealtimeBaseURL:   endpoint,
		RequestTimeout:    http2HealthRequestTimeout,
	})
	if err != nil {
		t.Fatal(err)
	}

	client := adapter.client.(*http.Client)
	transport := client.Transport.(*http.Transport)
	transport.TLSClientConfig = &tls.Config{RootCAs: roots}
	if transport.IdleConnTimeout != sfuIdleConnTimeout {
		t.Fatalf("transport idle timeout is %s, want %s", transport.IdleConnTimeout, sfuIdleConnTimeout)
	}
	forcedCloseClient := adapter.forcedCloseClient.(*http.Client)
	if forcedCloseClient.Transport != transport {
		t.Fatal("forced-close client does not share the configured transport")
	}
	t.Cleanup(client.CloseIdleConnections)
	return adapter, proxy, protocol
}

func newHTTP2HealthServer(t *testing.T) (string, *x509.CertPool, *atomic.Int32, *http2HealthProxy) {
	t.Helper()
	protocol := &atomic.Int32{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		protocol.CompareAndSwap(0, int32(r.ProtoMajor))
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)

	proxy, err := newHTTP2HealthProxy(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(proxy.Close)

	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	endpoint := "https://" + proxy.listener.Addr().String()
	return endpoint, roots, protocol, proxy
}

func assertInitialHTTP2Request(t *testing.T, adapter Adapter, protocol *atomic.Int32) {
	t.Helper()
	if _, err := adapter.VerifyConnectionMetadata(context.Background(), "connection"); err != nil {
		t.Fatalf("initial verify request: %v", err)
	}
	if got := protocol.Load(); got != 2 {
		t.Fatalf("initial request used HTTP/2 major version %d, want 2", got)
	}
}

func waitForHTTP2HealthRecovery(t *testing.T, adapter Adapter) {
	t.Helper()
	recoveryStarted := time.Now()
	results := make(chan http2HealthResult, 32)
	probeContext, cancelProbes := context.WithCancel(context.Background())
	defer cancelProbes()

	attempts := 0
	launchAttempt := func() {
		attempts++
		attempt := attempts
		startedAt := time.Now()
		requestContext, cancelRequest := context.WithCancel(probeContext)
		go func() {
			defer cancelRequest()
			_, requestErr := adapter.VerifyConnectionMetadata(requestContext, "connection")
			results <- http2HealthResult{attempt: attempt, startedAt: startedAt, err: requestErr}
		}()
	}

	ticker := time.NewTicker(http2HealthPollInterval)
	defer ticker.Stop()
	deadline := time.NewTimer(http2HealthRecoveryTimeout)
	defer deadline.Stop()
	launchAttempt()

	for {
		select {
		case result := <-results:
			if result.err == nil {
				cancelProbes()
				t.Logf("recovered on attempt %d after %s", result.attempt, time.Since(recoveryStarted))
				return
			}
			t.Logf("attempt %d started at %s failed: %v", result.attempt, result.startedAt.Sub(recoveryStarted), result.err)
		case <-ticker.C:
			launchAttempt()
		case <-deadline.C:
			t.Fatalf("adapter did not recover within %s after the proxy path returned (attempts=%d)", http2HealthRecoveryTimeout, attempts)
		}
	}
}

func newHTTP2HealthProxy(upstream string) (*http2HealthProxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	proxy := &http2HealthProxy{
		listener:   listener,
		upstream:   upstream,
		acceptDone: make(chan struct{}),
		links:      make(map[*http2HealthLink]struct{}),
	}
	go proxy.acceptConnections()
	return proxy, nil
}

func (p *http2HealthProxy) acceptConnections() {
	defer close(p.acceptDone)
	for {
		client, err := p.listener.Accept()
		if err != nil {
			return
		}
		upstream, err := net.DialTimeout("tcp", p.upstream, 5*time.Second)
		if err != nil {
			_ = client.Close()
			continue
		}

		link := &http2HealthLink{client: client, upstream: upstream}
		p.mu.Lock()
		link.dead = p.fault
		p.links[link] = struct{}{}
		p.mu.Unlock()

		p.pumps.Add(2)
		go p.pipe(client, upstream, link)
		go p.pipe(upstream, client, link)
	}
}

func (p *http2HealthProxy) pipe(source, destination net.Conn, link *http2HealthLink) {
	defer p.pumps.Done()
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := source.Read(buffer)
		if n > 0 {
			p.mu.Lock()
			discard := p.fault || link.dead
			p.mu.Unlock()
			if !discard {
				if _, writeErr := destination.Write(buffer[:n]); writeErr != nil {
					p.mu.Lock()
					discard = p.fault || link.dead
					p.mu.Unlock()
					if !discard {
						link.close()
					}
					return
				}
			}
		}
		if readErr != nil {
			p.mu.Lock()
			discard := p.fault || link.dead
			p.mu.Unlock()
			if !discard {
				link.close()
			}
			return
		}
	}
}

func (p *http2HealthProxy) blackhole() {
	p.mu.Lock()
	p.fault = true
	for link := range p.links {
		link.dead = true
	}
	p.mu.Unlock()
}

func (p *http2HealthProxy) endFault() {
	p.mu.Lock()
	p.fault = false
	p.mu.Unlock()
}

func (p *http2HealthProxy) Close() {
	_ = p.listener.Close()
	<-p.acceptDone

	p.mu.Lock()
	links := make([]*http2HealthLink, 0, len(p.links))
	for link := range p.links {
		links = append(links, link)
	}
	p.mu.Unlock()
	for _, link := range links {
		link.close()
	}
	p.pumps.Wait()
}

func (link *http2HealthLink) close() {
	link.closeOnce.Do(func() {
		_ = link.client.Close()
		_ = link.upstream.Close()
	})
}
