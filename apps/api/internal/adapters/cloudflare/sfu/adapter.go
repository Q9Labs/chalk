package sfu

import (
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
)

const (
	defaultEndpoint = "https://rtc.live.cloudflare.com/v1"
	stunServer      = "stun:stun.cloudflare.com:3478"
	syncOwner       = "elixir"
)

var ErrMissingConfig = errors.New("missing cloudflare sfu config")

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

func (a Adapter) CreateJoin(_ context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	if input.Provider != mediaplane.ProviderCloudflareSFU {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}

	participantRef := input.ExternalParticipantID
	if participantRef == "" {
		participantRef = input.ParticipantName
	}

	return mediaplane.Join{
		Provider:       mediaplane.ProviderCloudflareSFU,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"provider":   string(mediaplane.ProviderCloudflareSFU),
			"sessionRef": input.Session.Ref,
			"syncOwner":  syncOwner,
		},
		Metadata: a.providerMetadata(),
	}, nil
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

func (a Adapter) VerifySessionMetadata(ctx context.Context, sessionRef string) (SessionMetadata, error) {
	sessionRef = strings.TrimSpace(sessionRef)
	if sessionRef == "" {
		return SessionMetadata{}, mediaplane.ErrInvalidSessionRef
	}
	if a.client == nil {
		return SessionMetadata{}, mediaplane.ErrPlaneUnavailable
	}

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
