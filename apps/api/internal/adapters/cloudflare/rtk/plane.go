package rtk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

const defaultEndpoint = "https://api.cloudflare.com/client/v4"

var ErrMissingConfig = errors.New("missing cloudflare realtimekit config")

type httpClient interface {
	Do(*http.Request) (*http.Response, error)
}

type Plane struct {
	accountID         string
	apiToken          string
	appID             string
	presetFacilitator string
	presetContributor string
	endpoint          string
	client            httpClient
}

type meetingRequest struct {
	Title string `json:"title"`
}

type meetingResponse struct {
	ID string `json:"id"`
}

type participantRequest struct {
	Name                string `json:"name"`
	PresetName          string `json:"preset_name"`
	CustomParticipantID string `json:"custom_participant_id,omitempty"`
}

type participantResponse struct {
	AuthToken     string `json:"authToken"`
	Token         string `json:"token"`
	ParticipantID string `json:"participant_id"`
	ID            string `json:"id"`
}

type apiEnvelope struct {
	Result json.RawMessage `json:"result"`
	Data   json.RawMessage `json:"data"`
	Errors []apiError      `json:"errors"`
}

type apiError struct {
	Code    any    `json:"code"`
	Message string `json:"message"`
}

func NewPlane(cfg config.CloudflareRealtimeConfig) (Plane, error) {
	accountID := strings.TrimSpace(cfg.AccountID)
	apiToken := strings.TrimSpace(cfg.APIToken)
	appID := strings.TrimSpace(cfg.RTKAppID)
	if accountID == "" || apiToken == "" || appID == "" || cfg.RequestTimeout <= 0 {
		return Plane{}, ErrMissingConfig
	}

	return Plane{
		accountID:         accountID,
		apiToken:          apiToken,
		appID:             appID,
		presetFacilitator: strings.TrimSpace(cfg.RTKPresetFacilitator),
		presetContributor: strings.TrimSpace(cfg.RTKPresetContributor),
		endpoint:          defaultEndpoint,
		client:            &http.Client{Timeout: cfg.RequestTimeout},
	}, nil
}

func NewPlaneWithClient(cfg config.CloudflareRealtimeConfig, client httpClient, endpoint string) (Plane, error) {
	plane, err := NewPlane(cfg)
	if err != nil {
		return Plane{}, err
	}
	if client != nil {
		plane.client = client
	}
	if strings.TrimSpace(endpoint) != "" {
		plane.endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	}

	return plane, nil
}

func (p Plane) EnsureSession(ctx context.Context, input mediaplane.EnsureSessionInput) (mediaplane.Session, error) {
	if p.client == nil {
		return mediaplane.Session{}, mediaplane.ErrPlaneUnavailable
	}
	if input.Provider != mediaplane.ProviderCloudflareRTK {
		return mediaplane.Session{}, mediaplane.ErrInvalidProvider
	}

	title := input.Title
	if title == "" {
		title = input.SessionKey
	}

	var output meetingResponse
	if err := p.do(ctx, http.MethodPost, p.meetingsPath(), meetingRequest{Title: title}, &output); err != nil {
		return mediaplane.Session{}, err
	}
	if strings.TrimSpace(output.ID) == "" {
		return mediaplane.Session{}, fmt.Errorf("create rtk meeting: %w", mediaplane.ErrProviderFailed)
	}

	return mediaplane.Session{
		Provider: mediaplane.ProviderCloudflareRTK,
		Ref:      output.ID,
		Metadata: providerMetadata(p.appID),
	}, nil
}

func (p Plane) CreateJoin(ctx context.Context, input mediaplane.CreateJoinInput) (mediaplane.Join, error) {
	if p.client == nil {
		return mediaplane.Join{}, mediaplane.ErrPlaneUnavailable
	}
	if input.Provider != mediaplane.ProviderCloudflareRTK {
		return mediaplane.Join{}, mediaplane.ErrInvalidProvider
	}

	var output participantResponse
	if err := p.do(ctx, http.MethodPost, p.participantsPath(input.Session.Ref), participantRequest{
		Name:                input.ParticipantName,
		PresetName:          p.providerPreset(input.ParticipantPreset),
		CustomParticipantID: input.ExternalParticipantID,
	}, &output); err != nil {
		return mediaplane.Join{}, err
	}

	participantRef := strings.TrimSpace(output.ParticipantID)
	if participantRef == "" {
		participantRef = strings.TrimSpace(output.ID)
	}
	token := strings.TrimSpace(output.AuthToken)
	if token == "" {
		token = strings.TrimSpace(output.Token)
	}
	if participantRef == "" || token == "" {
		return mediaplane.Join{}, fmt.Errorf("add rtk participant: %w", mediaplane.ErrProviderFailed)
	}

	return mediaplane.Join{
		Provider:       mediaplane.ProviderCloudflareRTK,
		ParticipantRef: participantRef,
		ClientPayload: map[string]any{
			"token": token,
		},
		Metadata: providerMetadata(p.appID),
	}, nil
}

func (p Plane) RemoveParticipant(ctx context.Context, input mediaplane.RemoveParticipantInput) error {
	if p.client == nil {
		return mediaplane.ErrPlaneUnavailable
	}
	if input.Provider != mediaplane.ProviderCloudflareRTK {
		return mediaplane.ErrInvalidProvider
	}

	return p.do(ctx, http.MethodDelete, p.participantPath(input.SessionRef, input.ParticipantRef), nil, nil)
}

func (p Plane) EndSession(ctx context.Context, input mediaplane.EndSessionInput) error {
	if p.client == nil {
		return mediaplane.ErrPlaneUnavailable
	}
	if input.Provider != mediaplane.ProviderCloudflareRTK {
		return mediaplane.ErrInvalidProvider
	}

	return p.do(ctx, http.MethodPost, p.kickAllPath(input.SessionRef), nil, nil)
}

func (p Plane) SessionUsage(_ context.Context, input mediaplane.SessionUsageInput) (mediaplane.Usage, error) {
	if input.Provider != mediaplane.ProviderCloudflareRTK {
		return mediaplane.Usage{}, mediaplane.ErrInvalidProvider
	}

	return mediaplane.Usage{Metadata: providerMetadata(p.appID)}, nil
}

func (p Plane) providerPreset(preset string) string {
	switch preset {
	case "facilitator":
		if p.presetFacilitator != "" {
			return p.presetFacilitator
		}
	case "contributor":
		if p.presetContributor != "" {
			return p.presetContributor
		}
	}

	// TODO: replace temporary preset slugs when sync-side capability presets land.
	return preset
}

func (p Plane) meetingsPath() string {
	return fmt.Sprintf("/accounts/%s/realtime/kit/%s/meetings", p.accountID, p.appID)
}

func (p Plane) participantsPath(meetingID string) string {
	return fmt.Sprintf("%s/%s/participants", p.meetingsPath(), meetingID)
}

func (p Plane) participantPath(meetingID, participantID string) string {
	return fmt.Sprintf("%s/%s", p.participantsPath(meetingID), participantID)
}

func (p Plane) kickAllPath(meetingID string) string {
	return fmt.Sprintf("%s/%s/active-session/kick-all", p.meetingsPath(), meetingID)
}

func (p Plane) do(ctx context.Context, method string, path string, body any, output any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode rtk request: %w", errors.Join(mediaplane.ErrProviderFailed, err))
		}
		reader = bytes.NewReader(payload)
	}

	request, err := http.NewRequestWithContext(ctx, method, p.endpoint+path, reader)
	if err != nil {
		return fmt.Errorf("build rtk request: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	request.Header.Set("Authorization", "Bearer "+p.apiToken)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := p.client.Do(request)
	if err != nil {
		return fmt.Errorf("send rtk request: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read rtk response: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return rtkStatusError(response.StatusCode, payload)
	}
	if output == nil || len(payload) == 0 {
		return nil
	}

	if err := decodeResponse(payload, output); err != nil {
		return fmt.Errorf("decode rtk response: %w", errors.Join(mediaplane.ErrProviderFailed, err))
	}

	return nil
}

func decodeResponse(payload []byte, output any) error {
	var envelope apiEnvelope
	if err := json.Unmarshal(payload, &envelope); err == nil {
		switch {
		case len(envelope.Result) > 0:
			return json.Unmarshal(envelope.Result, output)
		case len(envelope.Data) > 0:
			return json.Unmarshal(envelope.Data, output)
		}
	}

	return json.Unmarshal(payload, output)
}

func rtkStatusError(statusCode int, payload []byte) error {
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
		return fmt.Errorf("rtk provider status %d: %w", statusCode, providerErr)
	}

	return fmt.Errorf("rtk provider status %d: %s: %w", statusCode, message, providerErr)
}

func providerMessage(payload []byte) string {
	var envelope apiEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil || len(envelope.Errors) == 0 {
		return ""
	}

	return strings.TrimSpace(envelope.Errors[0].Message)
}

func providerMetadata(appID string) map[string]string {
	return map[string]string{
		"app_id": appID,
	}
}
