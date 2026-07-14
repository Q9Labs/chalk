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

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

const (
	defaultEndpoint = "https://rtc.live.cloudflare.com/v1"
	stunServer      = "stun:stun.cloudflare.com:3478"
	syncOwner       = "elixir"
)

var ErrMissingConfig = errors.New("missing cloudflare sfu config")

var sfuTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/adapters/cloudflare/sfu")

type httpClient interface {
	Do(*http.Request) (*http.Response, error)
}

type Adapter struct {
	appID     string
	appSecret string
	endpoint  string
	client    httpClient
}

type SessionMetadata struct {
	Provider mediaplane.Provider
	Ref      string
	Metadata map[string]string
}

type apiError struct {
	Message string `json:"message"`
}

type apiEnvelope struct {
	Errors []apiError `json:"errors"`
}

type createSessionResponse struct {
	SessionID string `json:"sessionId"`
}

type tracksRequest struct {
	SessionDescription *mediaplane.SessionDescription `json:"sessionDescription,omitempty"`
	Tracks             []providerTrack                `json:"tracks"`
}

type providerTrack struct {
	Location  string `json:"location"`
	Mid       string `json:"mid,omitempty"`
	TrackName string `json:"trackName"`
	SessionID string `json:"sessionId,omitempty"`
}

type renegotiateRequest struct {
	SessionDescription mediaplane.SessionDescription `json:"sessionDescription"`
}

func NewAdapter(cfg config.CloudflareRealtimeConfig) (Adapter, error) {
	appID := strings.TrimSpace(cfg.RealtimeAppID)
	appSecret := strings.TrimSpace(cfg.RealtimeAppSecret)
	if appID == "" || appSecret == "" || cfg.RequestTimeout <= 0 {
		return Adapter{}, ErrMissingConfig
	}

	return Adapter{
		appID:     appID,
		appSecret: appSecret,
		endpoint:  defaultEndpoint,
		client:    &http.Client{Timeout: cfg.RequestTimeout},
	}, nil
}

func NewAdapterWithClient(cfg config.CloudflareRealtimeConfig, client httpClient, endpoint string) (Adapter, error) {
	adapter, err := NewAdapter(cfg)
	if err != nil {
		return Adapter{}, err
	}
	if client != nil {
		adapter.client = client
	}
	if strings.TrimSpace(endpoint) != "" {
		adapter.endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	}

	return adapter, nil
}

func (a Adapter) EnsureSession(_ context.Context, input mediaplane.EnsureSessionInput) (mediaplane.Session, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Session{}, mediaplane.ErrInvalidProvider
	}

	return mediaplane.Session{
		Provider: mediaplane.ProviderCloudflareSFU,
		Ref:      input.SessionKey,
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

	participantRef := input.ExternalParticipantID
	if participantRef == "" {
		participantRef = input.ParticipantName
	}

	return mediaplane.Join{
		Provider:       mediaplane.ProviderCloudflareSFU,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"connectionId": connectionID,
			"provider":     string(mediaplane.ProviderCloudflareSFU),
			"sessionRef":   input.Session.Ref,
			"stunServer":   stunServer,
			"syncOwner":    syncOwner,
		},
		Metadata: a.providerMetadata(),
	}, nil
}

func (a Adapter) AddTracks(ctx context.Context, input mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	var response mediaplane.TracksResponse
	tracks := make([]providerTrack, 0, len(input.Tracks))
	for _, track := range input.Tracks {
		tracks = append(tracks, providerTrack{Location: track.Location, Mid: track.Mid, TrackName: track.TrackName, SessionID: track.SessionID})
	}
	err := a.request(ctx, http.MethodPost, fmt.Sprintf("/sessions/%s/tracks/new", url.PathEscape(input.ConnectionID)), tracksRequest{
		SessionDescription: input.SessionDescription,
		Tracks:             tracks,
	}, &response, "add_tracks")
	return response, err
}

func (a Adapter) Renegotiate(ctx context.Context, input mediaplane.RenegotiateRequest) error {
	return a.request(ctx, http.MethodPut, fmt.Sprintf("/sessions/%s/renegotiate", url.PathEscape(input.ConnectionID)), renegotiateRequest{
		SessionDescription: input.SessionDescription,
	}, nil, "renegotiate")
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

func (a Adapter) request(ctx context.Context, method string, path string, body any, output any, operation string) (err error) {
	if a.client == nil {
		return mediaplane.ErrPlaneUnavailable
	}
	var encoded []byte
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode sfu request: %w", errors.Join(mediaplane.ErrProviderFailed, err))
		}
	}
	ctx, span := sfuTracer.Start(ctx, "mediaplane.cloudflare.sfu."+operation, trace.WithSpanKind(trace.SpanKindClient))
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "Cloudflare SFU request failed")
		}
		span.End()
	}()
	span.SetAttributes(attribute.String("http.request.method", method), attribute.String("server.address", "rtc.live.cloudflare.com"))
	request, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("%s/apps/%s%s", a.endpoint, url.PathEscape(a.appID), path), bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("build sfu request: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	request.Header.Set("Authorization", "Bearer "+a.appSecret)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	providerResponse, err := a.client.Do(request)
	if err != nil {
		return fmt.Errorf("send sfu request: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	defer providerResponse.Body.Close()
	span.SetAttributes(attribute.Int("http.response.status_code", providerResponse.StatusCode))
	payload, err := io.ReadAll(io.LimitReader(providerResponse.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read sfu response: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	if providerResponse.StatusCode < 200 || providerResponse.StatusCode >= 300 {
		return sfuStatusError(providerResponse.StatusCode, payload)
	}
	if output != nil {
		if err := json.Unmarshal(payload, output); err != nil {
			return fmt.Errorf("decode sfu response: %w", errors.Join(mediaplane.ErrProviderFailed, err))
		}
	}
	return nil
}

func (a Adapter) RemoveParticipant(context.Context, mediaplane.RemoveParticipantInput) error {
	return mediaplane.ErrUnsupportedOperation
}

func (a Adapter) EndSession(context.Context, mediaplane.EndSessionInput) error {
	return mediaplane.ErrUnsupportedOperation
}

func (a Adapter) SessionUsage(_ context.Context, input mediaplane.SessionUsageInput) (mediaplane.Usage, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Usage{}, mediaplane.ErrInvalidProvider
	}

	return mediaplane.Usage{Metadata: a.providerMetadata()}, nil
}

func (a Adapter) VerifySessionMetadata(ctx context.Context, sessionRef string) (metadata SessionMetadata, err error) {
	sessionRef = strings.TrimSpace(sessionRef)
	if sessionRef == "" {
		return SessionMetadata{}, mediaplane.ErrInvalidSessionRef
	}
	if a.client == nil {
		return SessionMetadata{}, mediaplane.ErrPlaneUnavailable
	}
	ctx, span := sfuTracer.Start(ctx, "mediaplane.cloudflare.sfu.verify_session", trace.WithSpanKind(trace.SpanKindClient))
	defer func() {
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "Cloudflare SFU request failed")
		}
		span.End()
	}()
	span.SetAttributes(attribute.String("http.request.method", http.MethodGet), attribute.String("server.address", "rtc.live.cloudflare.com"))

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/apps/%s/sessions/%s", a.endpoint, url.PathEscape(a.appID), url.PathEscape(sessionRef)), nil)
	if err != nil {
		return SessionMetadata{}, fmt.Errorf("build sfu request: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	request.Header.Set("Authorization", "Bearer "+a.appSecret)
	request.Header.Set("Accept", "application/json")

	response, err := a.client.Do(request)
	if err != nil {
		return SessionMetadata{}, fmt.Errorf("send sfu request: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	defer response.Body.Close()
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))

	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return SessionMetadata{}, fmt.Errorf("read sfu response: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return SessionMetadata{}, sfuStatusError(response.StatusCode, payload)
	}

	return SessionMetadata{
		Provider: mediaplane.ProviderCloudflareSFU,
		Ref:      sessionRef,
		Metadata: a.providerMetadata(),
	}, nil
}

func (a Adapter) providerMetadata() map[string]string {
	return map[string]string{
		"api_base":    fmt.Sprintf("%s/apps/%s", a.endpoint, a.appID),
		"app_id":      a.appID,
		"stun_server": stunServer,
		"sync_owner":  syncOwner,
	}
}

func sfuStatusError(statusCode int, payload []byte) error {
	providerErr := mediaplane.ErrProviderFailed
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		providerErr = mediaplane.ErrProviderUnauthorized
	case http.StatusNotFound:
		providerErr = mediaplane.ErrSessionNotFound
	case http.StatusTooManyRequests:
		providerErr = mediaplane.ErrProviderRateLimited
	}

	message := providerMessage(payload)
	if message == "" {
		return fmt.Errorf("sfu provider status %d: %w", statusCode, providerErr)
	}

	return fmt.Errorf("sfu provider status %d: %s: %w", statusCode, message, providerErr)
}

func providerMessage(payload []byte) string {
	var envelope apiEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil || len(envelope.Errors) == 0 {
		return ""
	}

	return strings.TrimSpace(envelope.Errors[0].Message)
}
