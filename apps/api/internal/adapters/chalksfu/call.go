package chalksfu

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
)

const (
	maxResponseBytes = 1 << 20
	maxAttempts      = 3
	retryBackoff     = 150 * time.Millisecond
)

// turnMintFailures counts joins that went out without TURN. A client that can
// reach only TCP 443 cannot connect media after one, so it is the signal to watch.
// Its only attribute is the media plane: an Episode id would make it unbounded.
var turnMintFailures, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu").Int64Counter(
	"chalk.sfu.turn_mint_failures",
	metric.WithDescription("Joins that got STUN only because minting TURN credentials failed"),
	metric.WithUnit("{join}"),
)

// failures counts control calls that ended in a provider failure after the adapter's retries.
// Attributes are bounded: the operation is the route with the session ID cut out, the stage
// is transport, http_status or decode, and the detail is a transport cause or a status class.
// No node, Tenant, Episode or Participant identity is attached, and no error text.
var callFailures, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu").Int64Counter(
	"chalk.api.chalk_sfu.failures",
	metric.WithDescription("Chalk SFU control call failures by bounded operation, stage and cause"),
	metric.WithUnit("{failure}"),
)

const (
	stageTransport  = "transport"
	stageHTTPStatus = "http_status"
	stageDecode     = "decode"
)

// newClient builds the mTLS client once for every node. The server certificate
// must verify against the configured CA and name ServerName, and the client
// presents its own certificate, so a stolen network position cannot reach the
// control API.
func newClient(config runtimeconfig.ChalkSFUConfig) (*http.Client, error) {
	if config.ApplicationID == "" || config.ServerName == "" || config.RequestTimeout <= 0 {
		return nil, fmt.Errorf("%w: application ID, server name and timeout", ErrMissingConfig)
	}
	roots, err := loadPool(config.CAFile)
	if err != nil {
		return nil, err
	}
	certificate, err := tls.LoadX509KeyPair(config.ClientCertFile, config.ClientKeyFile)
	if err != nil {
		return nil, fmt.Errorf("%w: client certificate: %v", ErrMissingConfig, err)
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			RootCAs:      roots,
			ServerName:   config.ServerName,
			Certificates: []tls.Certificate{certificate},
		},
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
	}
	return &http.Client{Transport: transport, Timeout: config.RequestTimeout}, nil
}

func newOperationID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "op-" + hex.EncodeToString(raw[:]), nil
}

// call posts one JSON body and decodes the reply. Transport failures and 502, 503
// and 504 replies retry with the same body, so the operation ID inside it makes
// the retry safe. Any other status is the answer. A transport error's text holds the
// node's control URL and IP, so only its cause leaves this function.
func (a *Adapter) call(ctx context.Context, path string, request, response any) error {
	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("%w: encode request", mediaplane.ErrProviderFailed)
	}
	endpoint := a.base.JoinPath(path).String()
	var lastErr error
	var lastFailure []attribute.KeyValue
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			select {
			case <-ctx.Done():
				return fmt.Errorf("%w: %v", mediaplane.ErrPlaneUnavailable, ctx.Err())
			case <-time.After(a.backoff * time.Duration(attempt-1)):
			}
		}
		status, payload, err := a.send(ctx, endpoint, body)
		switch {
		case err != nil:
			cause := mediaplane.ClassifyTransportCause(ctx, err)
			lastErr = fmt.Errorf("%w: transport: %s", mediaplane.ErrProviderFailed, cause)
			lastFailure = failureAttributes(path, stageTransport, attribute.String("chalk.provider.transport_cause", string(cause)))
			if cause == mediaplane.TransportCauseCallerCanceled {
				lastFailure = nil
			}
		case status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout:
			lastErr = classify(status, payload)
			lastFailure = failureAttributes(path, stageHTTPStatus, attribute.String("http.response.status_class", statusClass(status)))
		case status >= 200 && status < 300:
			if response == nil {
				return nil
			}
			if err := json.Unmarshal(payload, response); err != nil {
				recordFailure(ctx, failureAttributes(path, stageDecode))
				return fmt.Errorf("%w: decode response", mediaplane.ErrProviderFailed)
			}
			return nil
		default:
			err := classify(status, payload)
			if errors.Is(err, mediaplane.ErrProviderFailed) {
				recordFailure(ctx, failureAttributes(path, stageHTTPStatus, attribute.String("http.response.status_class", statusClass(status))))
			}
			return err
		}
		if ctx.Err() != nil {
			break
		}
	}
	recordFailure(ctx, lastFailure)
	return lastErr
}

// failureAttributes labels one failure. The operation is the route with a session ID cut out.
func failureAttributes(path, stage string, detail ...attribute.KeyValue) []attribute.KeyValue {
	operation := strings.TrimPrefix(path, "/v1/")
	if rest, ok := strings.CutPrefix(operation, "sessions/"); ok {
		_, action, _ := strings.Cut(rest, "/")
		operation = "sessions/" + action
	}
	attributes := []attribute.KeyValue{
		attribute.String("chalk.media_plane.provider", string(mediaplane.ProviderChalkSFU)),
		attribute.String("chalk.provider.operation", operation),
		attribute.String("chalk.provider.failure_stage", stage),
	}
	return append(attributes, detail...)
}

func recordFailure(ctx context.Context, attributes []attribute.KeyValue) {
	if attributes != nil {
		callFailures.Add(ctx, 1, metric.WithAttributes(attributes...))
	}
}

func statusClass(status int) string {
	return strconv.Itoa(status/100) + "xx"
}

// ready reads the node's readiness: its packet budget and the part live Episodes
// reserve. A draining node answers 503 with its state, which is a ready result
// with Draining set. Any other reply but 200 is not ready.
func (a *Adapter) ready(ctx context.Context) (wireReady, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base.JoinPath("/readyz").String(), nil)
	if err != nil {
		return wireReady{}, err
	}
	request.Header.Set("Accept", "application/json")
	reply, err := a.client.Do(request)
	if err != nil {
		return wireReady{}, err
	}
	defer reply.Body.Close()
	if reply.StatusCode != http.StatusOK && reply.StatusCode != http.StatusServiceUnavailable {
		return wireReady{}, fmt.Errorf("readiness status %d", reply.StatusCode)
	}
	var ready wireReady
	if err := json.NewDecoder(io.LimitReader(reply.Body, maxResponseBytes)).Decode(&ready); err != nil {
		return wireReady{}, fmt.Errorf("decode readiness (status %d): %w", reply.StatusCode, err)
	}
	if reply.StatusCode == http.StatusServiceUnavailable && !ready.Draining {
		return wireReady{}, fmt.Errorf("readiness status %d", reply.StatusCode)
	}
	return ready, nil
}

func (a *Adapter) send(ctx context.Context, endpoint string, body []byte) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(request.Header))
	reply, err := a.client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer reply.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(reply.Body, maxResponseBytes))
	return reply.StatusCode, payload, err
}

// errStaleGeneration means the SFU holds a newer generation of the session's scope.
var errStaleGeneration = errors.New("sfu session generation is stale")

// classify turns an SFU error reply into the port's errors. A gone session is
// the one case callers act on: it means the connection no longer exists.
func classify(status int, payload []byte) error {
	var envelope wireError
	_ = json.Unmarshal(payload, &envelope)
	code := envelope.Error.Code
	upstream := mediaplane.UpstreamFailure{Status: status, Code: code}
	switch {
	case status == http.StatusNotFound || code == "session_gone":
		return fmt.Errorf("%w: %w", mediaplane.ErrConnectionNotFound, upstream)
	case status == http.StatusBadRequest:
		return fmt.Errorf("%w: %w", mediaplane.ErrInvalidSignalRequest, upstream)
	case code == "stale_generation":
		return fmt.Errorf("%w: %w: %w", mediaplane.ErrProviderFailed, errStaleGeneration, upstream)
	case status == http.StatusTooManyRequests:
		return fmt.Errorf("%w: %w: %w", mediaplane.ErrProviderFailed, mediaplane.ErrProviderRateLimited, upstream)
	case status == http.StatusForbidden:
		return fmt.Errorf("%w: %w: %w", mediaplane.ErrProviderFailed, mediaplane.ErrProviderUnauthorized, upstream)
	case status == http.StatusNotImplemented:
		return fmt.Errorf("%w: %w", mediaplane.ErrUnsupportedOperation, upstream)
	default:
		return fmt.Errorf("%w: %w", mediaplane.ErrProviderFailed, upstream)
	}
}

func wireScopeOf(scope mediaplane.Scope) wireScope {
	return wireScope{TenantID: scope.TenantID, EpisodeID: scope.EpisodeID, ParticipantID: scope.ParticipantID, Generation: scope.Generation}
}

func sessionPath(connectionID, action string) (string, error) {
	if strings.TrimSpace(connectionID) == "" || connectionID != strings.TrimSpace(connectionID) || strings.ContainsAny(connectionID, "/?#") {
		return "", mediaplane.ErrInvalidConnectionRef
	}
	return "/v1/sessions/" + url.PathEscape(connectionID) + "/" + action, nil
}
