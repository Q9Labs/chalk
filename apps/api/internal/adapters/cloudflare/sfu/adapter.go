package sfu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/turn"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

const (
	forcedCloseTimeout      = 25 * time.Second
	sfuHTTP2SendPingTimeout = 5 * time.Second
	sfuHTTP2PingTimeout     = 5 * time.Second
	sfuIdleConnTimeout      = 90 * time.Second
	defaultEndpoint         = "https://rtc.live.cloudflare.com/v1"
	stunServer              = "stun:stun.cloudflare.com:3478"
	syncOwner               = "elixir"
)

var ErrMissingConfig = errors.New("missing cloudflare sfu config")

var sharedSFUTransport = sync.OnceValue(newSFUTransport)

type Adapter struct {
	appID             string
	appSecret         string
	endpoint          string
	client            httpClient
	forcedCloseClient httpClient
	captureReplay     *captureplane.ReplayCache
	sessions          *sessionRegistry
	turn              *turn.Credentials
}

func NewAdapter(cfg config.CloudflareRealtimeConfig) (Adapter, error) {
	return newAdapter(cfg, sharedSFUTransport())
}

func newAdapter(cfg config.CloudflareRealtimeConfig, transport *http.Transport) (Adapter, error) {
	appID := strings.TrimSpace(cfg.RealtimeAppID)
	appSecret := strings.TrimSpace(cfg.RealtimeAppSecret)
	if appID == "" || appSecret == "" || cfg.RequestTimeout <= 0 {
		return Adapter{}, ErrMissingConfig
	}

	endpoint := defaultEndpoint
	if strings.TrimSpace(cfg.RealtimeBaseURL) != "" {
		endpoint = strings.TrimRight(strings.TrimSpace(cfg.RealtimeBaseURL), "/")
	}

	return Adapter{
		appID:             appID,
		appSecret:         appSecret,
		endpoint:          endpoint,
		client:            &http.Client{Transport: transport, Timeout: cfg.RequestTimeout},
		forcedCloseClient: &http.Client{Transport: transport, Timeout: max(cfg.RequestTimeout, forcedCloseTimeout)},
		captureReplay:     captureplane.NewReplayCache(captureReplayCapacity),
		sessions:          sessionRegistryForApp(appID),
	}, nil
}

func newSFUTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.IdleConnTimeout = sfuIdleConnTimeout
	transport.HTTP2 = &http.HTTP2Config{
		SendPingTimeout: sfuHTTP2SendPingTimeout,
		PingTimeout:     sfuHTTP2PingTimeout,
	}
	return transport
}

func NewAdapterWithClient(cfg config.CloudflareRealtimeConfig, client httpClient, endpoint string) (Adapter, error) {
	adapter, err := NewAdapter(cfg)
	if err != nil {
		return Adapter{}, err
	}
	if client != nil {
		adapter.client = client
		adapter.forcedCloseClient = client
	}
	if strings.TrimSpace(endpoint) != "" {
		adapter.endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	}

	return adapter, nil
}

func (a Adapter) EnsureEpisode(_ context.Context, input mediaplane.EnsureEpisodeInput) (mediaplane.Episode, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Episode{}, mediaplane.ErrInvalidProvider
	}

	return mediaplane.Episode{
		Provider: mediaplane.ProviderCloudflareSFU,
		Ref:      input.EpisodeKey,
		Metadata: a.providerMetadata(),
	}, nil
}

func (a Adapter) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}
	connectionID, err := a.createConnection(ctx)
	if err != nil {
		return mediaplane.Join{}, err
	}
	a.sessions.issue(connectionID)

	participantRef := input.ExternalParticipantID
	if participantRef == "" {
		participantRef = input.ParticipantName
	}

	return a.joinForConnection(input.Episode.Ref, participantRef, connectionID, a.iceServers(ctx, input.AllowRelay)), nil
}

func (a Adapter) ResumeJoin(ctx context.Context, input mediaplane.ResumeJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}

	return a.joinForConnection(input.Episode.Ref, input.ExternalParticipantID, input.ConnectionRef, a.iceServers(ctx, input.AllowRelay)), nil
}

func (a Adapter) InspectSession(ctx context.Context, input mediaplane.InspectSessionRequest) (mediaplane.SessionState, error) {
	var response inspectSessionResponse
	statusCode, err := a.requestStatus(ctx, http.MethodGet, fmt.Sprintf("/sessions/%s", url.PathEscape(a.sessions.providerID(input.ConnectionID))), nil, &response, "get_session")
	if err != nil {
		var failure providerFailure
		if errors.As(err, &failure) && (failure.statusCode == http.StatusNotFound || failure.statusCode == http.StatusGone) {
			return mediaplane.SessionState{Found: false}, nil
		}
		return mediaplane.SessionState{}, err
	}
	code := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(response.ErrorCode), "-", "_"))
	if code == "session_not_found" || code == "connection_not_found" {
		return mediaplane.SessionState{Found: false}, nil
	}
	if strings.TrimSpace(response.ErrorCode) != "" {
		return mediaplane.SessionState{}, newProviderResponseFailure("get_session", failureStageTopLevel, statusCode, response.ErrorCode, response.ErrorDescription, len(response.Tracks), 0)
	}
	tracks := make([]mediaplane.SessionTrack, 0, len(response.Tracks))
	for _, track := range response.Tracks {
		tracks = append(tracks, mediaplane.SessionTrack{
			Location: track.Location, Mid: track.Mid, TrackName: track.TrackName,
			Active: !strings.EqualFold(strings.TrimSpace(track.Status), "inactive"),
		})
	}
	return mediaplane.SessionState{Found: true, Tracks: tracks}, nil
}

func (a Adapter) createConnection(ctx context.Context) (string, error) {
	var response createSessionResponse
	if err := a.request(ctx, http.MethodPost, "/sessions/new", nil, &response, "create_connection"); err != nil {
		return "", err
	}
	response.SessionID = strings.TrimSpace(response.SessionID)
	if response.SessionID == "" {
		return "", fmt.Errorf("decode sfu connection response: %w", mediaplane.ErrProviderFailed)
	}
	return response.SessionID, nil
}

func (a Adapter) request(ctx context.Context, method string, path string, body any, output any, operation string) error {
	_, err := a.requestStatus(ctx, method, path, body, output, operation)
	return err
}

// requestStatus returns the upstream HTTP status, or 0 when no response arrived.
func (a Adapter) requestStatus(ctx context.Context, method string, path string, body any, output any, operation string) (statusCode int, err error) {
	ctx, span := sfuTracer.Start(ctx, "mediaplane.cloudflare.sfu."+operation, trace.WithSpanKind(trace.SpanKindClient))
	responseBytes := 0
	defer func() {
		if err != nil {
			err = enrichProviderFailure(err, body, responseBytes)
			if !errors.Is(err, context.Canceled) {
				span.RecordError(sfuSpanError(err))
				span.SetStatus(codes.Error, "Cloudflare SFU request failed")
			}
			recordProviderFailure(ctx, span, err)
		}
		span.End()
	}()
	span.SetAttributes(attribute.String("http.request.method", method), attribute.String("server.address", "rtc.live.cloudflare.com"))

	if a.client == nil {
		return 0, newProviderFailure(operation, failureStageTransport, 0, "plane_unavailable")
	}
	var encoded []byte
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return 0, newProviderFailure(operation, failureStageContract, 0, "invalid_request")
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("%s/apps/%s%s", a.endpoint, url.PathEscape(a.appID), path), bytes.NewReader(encoded))
	if err != nil {
		return 0, newProviderFailure(operation, failureStageContract, 0, "invalid_request")
	}
	request.Header.Set("Authorization", "Bearer "+a.appSecret)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	timing := &callTrace{}
	var responseHeader http.Header
	defer func() { timing.log(ctx, operation, traceInputFor(body), statusCode, responseHeader, traceFailed(err)) }()
	providerResponse, err := a.client.Do(request.WithContext(timing.attach(ctx)))
	if err != nil {
		return 0, newTransportFailure(ctx, operation, 0, err)
	}
	defer providerResponse.Body.Close()
	responseHeader = providerResponse.Header
	span.SetAttributes(attribute.Int("http.response.status_code", providerResponse.StatusCode))
	payload, err := io.ReadAll(io.LimitReader(providerResponse.Body, 1<<20))
	timing.readDone()
	if err != nil {
		return providerResponse.StatusCode, newTransportFailure(ctx, operation, providerResponse.StatusCode, err)
	}
	responseBytes = len(payload)
	if providerResponse.StatusCode < 200 || providerResponse.StatusCode >= 300 {
		return providerResponse.StatusCode, sfuStatusError(operation, providerResponse.StatusCode, payload)
	}
	if output != nil {
		if err := json.Unmarshal(payload, output); err != nil {
			return providerResponse.StatusCode, newProviderFailure(operation, failureStageDecode, providerResponse.StatusCode, "invalid_json")
		}
		if validator, ok := output.(responseValidator); ok {
			if err := validator.providerError(operation, providerResponse.StatusCode); err != nil {
				if response, ok := output.(*captureTracksResponse); ok {
					for _, track := range response.Tracks {
						if strings.EqualFold(strings.TrimSpace(track.ErrorCode), "not_found_track_error") {
							var failure providerFailure
							if errors.As(err, &failure) {
								failure.details.responseSnapshot = captureResponseSnapshot(payload)
								err = failure
							}
							break
						}
					}
				}
				return providerResponse.StatusCode, err
			}
		}
	}
	return providerResponse.StatusCode, nil
}

func (a Adapter) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	return mediaplane.ErrUnsupportedOperation
}

func (a Adapter) EndEpisode(context.Context, mediaplane.EndEpisodeInput) error {
	return mediaplane.ErrUnsupportedOperation
}

func (a Adapter) EpisodeUsage(_ context.Context, input mediaplane.EpisodeUsageInput) (mediaplane.Usage, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Usage{}, mediaplane.ErrInvalidProvider
	}

	return mediaplane.Usage{Metadata: a.providerMetadata()}, nil
}
