package webhooks

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type DNSResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type DeliveryRequest struct {
	URL, EventID, Timestamp, Signature string
	Body                               []byte
}
type DeliveryResponse struct {
	Status     int
	RetryAfter time.Duration
	Latency    time.Duration
}
type DeliveryError struct {
	Code      string
	Retryable bool
}

func (e DeliveryError) Error() string { return e.Code }

type DeliveryClient struct {
	resolver    DNSResolver
	dialContext func(context.Context, string, string) (net.Conn, error)
	rootCAs     *x509.CertPool
	timeout     time.Duration
}

func NewDeliveryClient(resolver DNSResolver) *DeliveryClient {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	dialer := net.Dialer{Timeout: 3 * time.Second}
	return &DeliveryClient{resolver: resolver, dialContext: dialer.DialContext, timeout: 10 * time.Second}
}

func (c *DeliveryClient) Deliver(ctx context.Context, input DeliveryRequest) (DeliveryResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	parsed, _, err := ValidateEndpointURL(input.URL)
	if err != nil {
		RecordSSRFRejection(ctx, "url_policy")
		return DeliveryResponse{}, DeliveryError{Code: "unsafe_url", Retryable: false}
	}
	destination, _ := url.Parse(parsed)
	addresses, err := c.resolver.LookupNetIP(ctx, "ip", destination.Hostname())
	if err != nil || len(addresses) == 0 {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return DeliveryResponse{}, DeliveryError{Code: "timeout", Retryable: true}
		}
		return DeliveryResponse{}, DeliveryError{Code: "dns_failed", Retryable: true}
	}
	publicCount := 0
	for _, address := range addresses {
		if !PublicAddress(address) {
			class := "blocked_address"
			if publicCount > 0 || len(addresses) > 1 {
				class = "mixed_dns_answer"
			}
			RecordSSRFRejection(ctx, class)
			return DeliveryResponse{}, DeliveryError{Code: "ssrf_blocked", Retryable: false}
		}
		publicCount++
	}
	address := addresses[0]
	transport := &http.Transport{
		Proxy:           nil,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: destination.Hostname(), RootCAs: c.rootCAs},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return c.dialContext(ctx, network, net.JoinHostPort(address.String(), "443"))
		},
		DisableKeepAlives:      true,
		ForceAttemptHTTP2:      false,
		ResponseHeaderTimeout:  c.timeout,
		MaxResponseHeaderBytes: 64 << 10,
	}
	client := &http.Client{Transport: transport, Timeout: c.timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed, bytes.NewReader(input.Body))
	if err != nil {
		return DeliveryResponse{}, DeliveryError{Code: "request_invalid", Retryable: false}
	}
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("User-Agent", "Chalk-Webhooks/1.0")
	request.Header.Set("webhook-id", input.EventID)
	request.Header.Set("webhook-timestamp", input.Timestamp)
	request.Header.Set("webhook-signature", input.Signature)
	startedAt := time.Now()
	response, err := client.Do(request)
	if err != nil {
		return DeliveryResponse{Latency: time.Since(startedAt)}, classifyDeliveryError(ctx, err)
	}
	defer response.Body.Close()
	read, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, MaxResponseBytes+1))
	latency := time.Since(startedAt)
	if readErr != nil {
		return DeliveryResponse{Latency: latency}, DeliveryError{Code: "network_failed", Retryable: true}
	}
	if read > MaxResponseBytes {
		return DeliveryResponse{Latency: latency}, DeliveryError{Code: "response_too_large", Retryable: false}
	}
	if response.StatusCode < 100 || response.StatusCode > 599 {
		return DeliveryResponse{Latency: latency}, DeliveryError{Code: "invalid_http_status", Retryable: false}
	}
	result := DeliveryResponse{Status: response.StatusCode, Latency: latency}
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusServiceUnavailable {
		result.RetryAfter = boundedRetryAfter(response.Header.Get("Retry-After"), time.Now())
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return result, nil
	}
	return result, DeliveryError{Code: fmt.Sprintf("http_%d", response.StatusCode/100) + "xx", Retryable: response.StatusCode == 408 || response.StatusCode == 425 || response.StatusCode == 429 || response.StatusCode >= 500}
}

func classifyDeliveryError(ctx context.Context, err error) DeliveryError {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return DeliveryError{Code: "timeout", Retryable: true}
	}
	if strings.Contains(err.Error(), "server response headers exceeded") {
		return DeliveryError{Code: "response_headers_too_large", Retryable: false}
	}
	var certificateInvalid x509.CertificateInvalidError
	var unknownAuthority x509.UnknownAuthorityError
	var hostnameError x509.HostnameError
	var tlsHeaderError tls.RecordHeaderError
	if errors.As(err, &certificateInvalid) || errors.As(err, &unknownAuthority) || errors.As(err, &hostnameError) || errors.As(err, &tlsHeaderError) {
		return DeliveryError{Code: "tls_failed", Retryable: false}
	}
	var networkError net.Error
	if errors.As(err, &networkError) {
		if networkError.Timeout() {
			return DeliveryError{Code: "timeout", Retryable: true}
		}
		return DeliveryError{Code: "connect_failed", Retryable: true}
	}
	return DeliveryError{Code: "network_failed", Retryable: true}
}

func boundedRetryAfter(value string, now time.Time) time.Duration {
	var delay time.Duration
	if seconds, err := strconv.Atoi(value); err == nil {
		delay = time.Duration(seconds) * time.Second
	} else if at, err := http.ParseTime(value); err == nil {
		delay = at.Sub(now)
	}
	if delay < 0 {
		return 0
	}
	if delay > 24*time.Hour {
		return 24 * time.Hour
	}
	return delay
}
