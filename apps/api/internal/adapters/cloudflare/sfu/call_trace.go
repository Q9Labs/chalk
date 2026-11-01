package sfu

import (
	"context"
	"crypto/tls"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptrace"
	"regexp"
	"strings"
	"sync"
	"time"
)

// coloSuffix matches the data-center code that ends a cf-ray header, such as "8f3c1a2b4d5e6f70-FRA".
var coloSuffix = regexp.MustCompile(`-([A-Za-z]{3})$`)

// callTrace times the phases of one Cloudflare call, so a slow call can be told apart as slow DNS,
// a slow connect or handshake, a stale reused connection, or a slow Cloudflare answer. It logs only
// durations, the address family and the 3-letter colo: never an address, a ray ID or a body.
type callTrace struct {
	mu                               sync.Mutex
	dnsStart, connectStart, tlsStart time.Time
	dnsDone, connectDone, tlsDone    time.Time
	wroteRequest, firstByte          time.Time
	bodyDone                         time.Time
	reused                           bool
	idle                             time.Duration
	family                           string
}

// attach returns a context whose HTTP client calls report their phases to the trace. The hooks may run
// on several goroutines, because the dialer races IPv4 against IPv6.
func (t *callTrace) attach(ctx context.Context) context.Context {
	return httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		DNSStart:     func(httptrace.DNSStartInfo) { t.stamp(&t.dnsStart) },
		DNSDone:      func(httptrace.DNSDoneInfo) { t.stamp(&t.dnsDone) },
		ConnectStart: func(string, string) { t.stampFirst(&t.connectStart) },
		// A failed dial is stamped too, so a connect that timed out still shows how long it took.
		ConnectDone:       func(string, string, error) { t.stamp(&t.connectDone) },
		TLSHandshakeStart: func() { t.stamp(&t.tlsStart) },
		TLSHandshakeDone:  func(tls.ConnectionState, error) { t.stamp(&t.tlsDone) },
		GotConn: func(info httptrace.GotConnInfo) {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.reused = info.Reused
			t.idle = info.IdleTime
			t.family = addressFamily(info.Conn.RemoteAddr())
		},
		WroteRequest:         func(httptrace.WroteRequestInfo) { t.stamp(&t.wroteRequest) },
		GotFirstResponseByte: func() { t.stamp(&t.firstByte) },
	})
}

func (t *callTrace) stamp(at *time.Time) {
	t.mu.Lock()
	*at = time.Now()
	t.mu.Unlock()
}

// stampFirst keeps the earliest time, because a dual-stack dial starts one connect per address.
func (t *callTrace) stampFirst(at *time.Time) {
	t.mu.Lock()
	if at.IsZero() {
		*at = time.Now()
	}
	t.mu.Unlock()
}

// log writes one line for the call. Phases that did not happen, such as DNS on a reused connection, log 0.
// A failed call logs at warn, so its phases survive a production log level of warn.
func (t *callTrace) log(ctx context.Context, operation string, input traceInput, statusCode int, header http.Header, failed bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	level := slog.LevelInfo
	if failed {
		level = slog.LevelWarn
	}
	slog.Default().Log(
		ctx,
		level,
		"Cloudflare SFU call trace",
		"event", "cloudflare_sfu.call_trace",
		"operation", operation,
		"kind", input.kind,
		"track_count", input.trackCount,
		"http_status", statusCode,
		"dns_ms", phaseMs(t.dnsStart, t.dnsDone),
		"connect_ms", phaseMs(t.connectStart, t.connectDone),
		"tls_ms", phaseMs(t.tlsStart, t.tlsDone),
		// Time Cloudflare took to start answering once the request was sent.
		"ttfb_ms", phaseMs(t.wroteRequest, t.firstByte),
		// Time from the first response byte until the whole body was read.
		"body_ms", phaseMs(t.firstByte, t.bodyDone),
		"conn_reused", t.reused,
		"conn_idle_ms", t.idle.Milliseconds(),
		"ip_family", t.family,
		"colo", coloFromRay(header.Get("Cf-Ray")),
	)
}

// traceInput describes the request without its content: pull for remote tracks, publish for local ones.
type traceInput struct {
	kind       string
	trackCount int
}

func traceInputFor(body any) traceInput {
	var locations []string
	switch request := body.(type) {
	case tracksRequest:
		for _, track := range request.Tracks {
			locations = append(locations, track.Location)
		}
	case captureTracksRequest:
		for _, track := range request.Tracks {
			locations = append(locations, track.Location)
		}
	default:
		return traceInput{}
	}
	var remote, local int
	for _, location := range locations {
		if location == "remote" {
			remote++
		} else {
			local++
		}
	}
	switch {
	case remote > 0 && local > 0:
		return traceInput{kind: "mixed", trackCount: len(locations)}
	case remote > 0:
		return traceInput{kind: "pull", trackCount: remote}
	case local > 0:
		return traceInput{kind: "publish", trackCount: local}
	}
	return traceInput{}
}

// readDone marks the end of the response body read.
func (t *callTrace) readDone() { t.stamp(&t.bodyDone) }

func phaseMs(start, done time.Time) int64 {
	if start.IsZero() || done.IsZero() || done.Before(start) {
		return 0
	}
	return done.Sub(start).Milliseconds()
}

func addressFamily(address net.Addr) string {
	tcp, ok := address.(*net.TCPAddr)
	if !ok {
		return ""
	}
	if tcp.IP.To4() != nil {
		return "v4"
	}
	return "v6"
}

// coloFromRay returns the 3-letter colo from a cf-ray value, upper-cased, or "" when there is none.
func coloFromRay(ray string) string {
	match := coloSuffix.FindStringSubmatch(strings.TrimSpace(ray))
	if match == nil {
		return ""
	}
	return strings.ToUpper(match[1])
}
