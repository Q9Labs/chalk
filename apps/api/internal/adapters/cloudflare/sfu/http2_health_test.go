package sfu

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
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
	http2HealthHandlerDelay    = 500 * time.Millisecond
)

type http2HealthServerState struct {
	protocol               atomic.Int32
	delayNextRequest       atomic.Bool
	delayedRequestReceived chan struct{}
}

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
		adapter, proxy, serverState := newHTTP2HealthAdapter(t)
		assertInitialHTTP2Request(t, adapter, serverState)

		serverState.delayNextRequest.Store(true)
		requestResult := make(chan error, 1)
		requestStarted := time.Now()
		go func() {
			_, err := adapter.VerifyConnectionMetadata(context.Background(), "connection")
			requestResult <- err
		}()
		select {
		case <-serverState.delayedRequestReceived:
		case <-time.After(http2HealthRequestTimeout + time.Second):
			t.Fatal("server did not receive delayed request")
		}

		faultStarted := time.Now()
		proxy.blackhole()
		var requestErr error
		select {
		case requestErr = <-requestResult:
		case <-time.After(http2HealthRequestTimeout + time.Second):
			t.Fatal("in-flight request did not time out")
		}
		var timeoutFailure interface{ ProviderFailureCode() string }
		if !errors.As(requestErr, &timeoutFailure) || timeoutFailure.ProviderFailureCode() != "timeout" {
			t.Fatalf("in-flight request error = %v, want adapter timeout", requestErr)
		}
		t.Logf("in-flight request timed out after %s", time.Since(requestStarted))

		if remaining := http2HealthFaultWindow - time.Since(faultStarted); remaining > 0 {
			time.Sleep(remaining)
		}
		proxy.endFault()

		waitForHTTP2HealthRecovery(t, adapter)
	})

	t.Run("idle", func(t *testing.T) {
		adapter, proxy, serverState := newHTTP2HealthAdapter(t)
		assertInitialHTTP2Request(t, adapter, serverState)

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

func TestNewAdapterSharesOneConfiguredTransport(t *testing.T) {
	firstConfig := config.CloudflareRealtimeConfig{
		RealtimeAppID:     "first-test-app",
		RealtimeAppSecret: "first-test-secret",
		RequestTimeout:    2 * time.Second,
	}
	secondConfig := config.CloudflareRealtimeConfig{
		RealtimeAppID:     "second-test-app",
		RealtimeAppSecret: "second-test-secret",
		RequestTimeout:    30 * time.Second,
	}
	first, err := NewAdapter(firstConfig)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewAdapter(secondConfig)
	if err != nil {
		t.Fatal(err)
	}

	firstClient := first.client.(*http.Client)
	firstForcedCloseClient := first.forcedCloseClient.(*http.Client)
	secondClient := second.client.(*http.Client)
	secondForcedCloseClient := second.forcedCloseClient.(*http.Client)
	transport, ok := firstClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("client transport has type %T, want *http.Transport", firstClient.Transport)
	}
	for name, client := range map[string]*http.Client{
		"first forced-close":  firstForcedCloseClient,
		"second":              secondClient,
		"second forced-close": secondForcedCloseClient,
	} {
		if client.Transport != transport {
			t.Errorf("%s client does not share the configured transport", name)
		}
	}
	if firstClient.Timeout != firstConfig.RequestTimeout || secondClient.Timeout != secondConfig.RequestTimeout {
		t.Errorf("normal client timeouts = %s and %s, want %s and %s", firstClient.Timeout, secondClient.Timeout, firstConfig.RequestTimeout, secondConfig.RequestTimeout)
	}
	if firstForcedCloseClient.Timeout != forcedCloseTimeout || secondForcedCloseClient.Timeout != secondConfig.RequestTimeout {
		t.Errorf("forced-close client timeouts = %s and %s, want %s and %s", firstForcedCloseClient.Timeout, secondForcedCloseClient.Timeout, forcedCloseTimeout, secondConfig.RequestTimeout)
	}
	if transport.HTTP2 == nil {
		t.Fatal("shared transport has no HTTP/2 config")
	}
	if transport.HTTP2.SendPingTimeout != 5*time.Second {
		t.Errorf("HTTP/2 send-ping timeout = %s, want 5s", transport.HTTP2.SendPingTimeout)
	}
	if transport.HTTP2.PingTimeout != 5*time.Second {
		t.Errorf("HTTP/2 ping timeout = %s, want 5s", transport.HTTP2.PingTimeout)
	}
	if transport.IdleConnTimeout != 90*time.Second {
		t.Errorf("idle connection timeout = %s, want 90s", transport.IdleConnTimeout)
	}
	if !transport.ForceAttemptHTTP2 {
		t.Error("shared transport does not force HTTP/2")
	}
}

func newHTTP2HealthAdapter(t *testing.T) (Adapter, *http2HealthProxy, *http2HealthServerState) {
	t.Helper()
	endpoint, roots, serverState, proxy := newHTTP2HealthServer(t)
	transport := newSFUTransport()
	transport.TLSClientConfig = &tls.Config{RootCAs: roots}
	adapter, err := newAdapter(config.CloudflareRealtimeConfig{
		RealtimeAppID:     "test-app",
		RealtimeAppSecret: "test-secret",
		RealtimeBaseURL:   endpoint,
		RequestTimeout:    http2HealthRequestTimeout,
	}, transport)
	if err != nil {
		t.Fatal(err)
	}

	client := adapter.client.(*http.Client)
	if client.Transport != transport {
		t.Fatal("client does not use the test transport")
	}
	if transport.IdleConnTimeout != sfuIdleConnTimeout {
		t.Fatalf("transport idle timeout is %s, want %s", transport.IdleConnTimeout, sfuIdleConnTimeout)
	}
	forcedCloseClient := adapter.forcedCloseClient.(*http.Client)
	if forcedCloseClient.Transport != transport {
		t.Fatal("forced-close client does not share the configured transport")
	}
	t.Cleanup(client.CloseIdleConnections)
	return adapter, proxy, serverState
}

func newHTTP2HealthServer(t *testing.T) (string, *x509.CertPool, *http2HealthServerState, *http2HealthProxy) {
	t.Helper()
	serverState := &http2HealthServerState{
		delayedRequestReceived: make(chan struct{}, 1),
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverState.protocol.CompareAndSwap(0, int32(r.ProtoMajor))
		if serverState.delayNextRequest.CompareAndSwap(true, false) {
			serverState.delayedRequestReceived <- struct{}{}
			time.Sleep(http2HealthHandlerDelay)
		}
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
	return endpoint, roots, serverState, proxy
}

func assertInitialHTTP2Request(t *testing.T, adapter Adapter, serverState *http2HealthServerState) {
	t.Helper()
	if _, err := adapter.VerifyConnectionMetadata(context.Background(), "connection"); err != nil {
		t.Fatalf("initial verify request: %v", err)
	}
	if got := serverState.protocol.Load(); got != 2 {
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
