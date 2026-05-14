package transcription

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	domain "github.com/Q9Labs/chalk/internal/domain/transcription"
	domainwebhook "github.com/Q9Labs/chalk/internal/domain/webhook"
	"github.com/google/uuid"
)

const (
	cloudflareWhisperDefaultModel = "@cf/openai/whisper-large-v3-turbo"
	cloudflareDispatchPath        = "/dispatch"
)

// CloudflareProvider dispatches transcription jobs to the dedicated Cloudflare Worker.
type CloudflareProvider struct {
	workerURL      string
	dispatchSecret string
	model          string
	client         *http.Client
}

// NewCloudflareProvider creates a new Cloudflare queue-backed transcription provider.
func NewCloudflareProvider(workerURL, dispatchSecret, model string) *CloudflareProvider {
	if strings.TrimSpace(model) == "" {
		model = cloudflareWhisperDefaultModel
	}

	return &CloudflareProvider{
		workerURL:      strings.TrimRight(workerURL, "/"),
		dispatchSecret: dispatchSecret,
		model:          model,
		client:         &http.Client{Timeout: 30 * time.Second},
	}
}

func (p *CloudflareProvider) Transcribe(context.Context, domain.TranscriptionRequest) (*domain.TranscriptionResult, error) {
	return nil, fmt.Errorf("cloudflare provider dispatches asynchronously")
}

func (p *CloudflareProvider) Dispatch(ctx context.Context, request domain.TranscriptionRequest) (*domain.DispatchResult, error) {
	payload := cloudflareDispatchRequest{
		TranscriptID:     request.TranscriptID,
		RecordingID:      request.RecordingID,
		RoomID:           request.RoomID,
		AudioURL:         request.AudioURL,
		AudioStoragePath: request.AudioStoragePath,
		LanguageHint:     request.LanguageHint,
		CallbackURL:      request.CallbackURL,
		ProviderModel:    firstNonEmpty(request.ProviderModel, p.model),
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal cloudflare dispatch request: %w", err)
	}

	endpoint := p.workerURL + cloudflareDispatchPath
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create cloudflare dispatch request: %w", err)
	}

	timestamp := time.Now().Unix()
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Chalk-Timestamp", fmt.Sprintf("%d", timestamp))
	httpReq.Header.Set("X-Chalk-Signature", domainwebhook.GenerateSignature(p.dispatchSecret, timestamp, body))

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("dispatch cloudflare transcription job: %w", err)
	}
	defer resp.Body.Close()

	var response cloudflareDispatchResponse
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("decode cloudflare dispatch response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if response.Error != "" {
			return nil, fmt.Errorf("cloudflare dispatch failed: %s", response.Error)
		}
		return nil, fmt.Errorf("cloudflare dispatch failed: status=%s", resp.Status)
	}

	return &domain.DispatchResult{
		ProviderJobID: response.JobID,
	}, nil
}

func (p *CloudflareProvider) Name() string {
	return "cloudflare"
}

func (p *CloudflareProvider) MaxFileSize() int64 {
	return 0
}

type cloudflareDispatchRequest struct {
	TranscriptID     uuid.UUID `json:"transcript_id"`
	RecordingID      uuid.UUID `json:"recording_id"`
	RoomID           uuid.UUID `json:"room_id"`
	AudioURL         string    `json:"audio_url"`
	AudioStoragePath string    `json:"audio_storage_path"`
	LanguageHint     string    `json:"language_hint,omitempty"`
	CallbackURL      string    `json:"callback_url"`
	ProviderModel    string    `json:"provider_model,omitempty"`
}

type cloudflareDispatchResponse struct {
	Accepted bool   `json:"accepted"`
	JobID    string `json:"job_id,omitempty"`
	Error    string `json:"error,omitempty"`
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
