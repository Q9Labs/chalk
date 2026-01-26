package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client is the Cloudflare RealtimeKit API client
type Client struct {
	httpClient *http.Client
	baseURL    string
	accountID  string
	appID      string
	apiToken   string
}

// Config holds the configuration for the Cloudflare client
type Config struct {
	AccountID string
	AppID     string
	APIToken  string
}

// NewClient creates a new Cloudflare RealtimeKit client
func NewClient(cfg Config) *Client {
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		baseURL:    "https://api.cloudflare.com/client/v4",
		accountID:  cfg.AccountID,
		appID:      cfg.AppID,
		apiToken:   cfg.APIToken,
	}
}

// IsConfigured returns true if the client has valid Cloudflare credentials
func (c *Client) IsConfigured() bool {
	return c.accountID != "" && c.appID != "" && c.apiToken != ""
}

// endpoint builds the full API endpoint URL
func (c *Client) endpoint(path string) string {
	return fmt.Sprintf("%s/accounts/%s/realtime/kit/%s%s",
		c.baseURL, c.accountID, c.appID, path)
}

// doRequest performs an HTTP request with proper headers
func (c *Client) doRequest(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	var bodyReader io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(jsonBody)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.endpoint(path), bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", "application/json")

	return c.httpClient.Do(req)
}

// CreateMeeting creates a new meeting in Cloudflare RealtimeKit
// Returns mock data if Cloudflare is not configured (for demo/testing)
func (c *Client) CreateMeeting(ctx context.Context, req CreateMeetingRequest) (*Meeting, error) {
	if !c.IsConfigured() {
		// Return mock meeting for demo mode when Cloudflare is not configured
		return &Meeting{
			ID:     fmt.Sprintf("demo-%d", time.Now().UnixNano()),
			Status: "active",
		}, nil
	}

	resp, err := c.doRequest(ctx, "POST", "/meetings", req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read raw body first for debugging
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	// Log response for debugging
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result Response[Meeting]
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	// Check both Data and Result fields
	if result.Result != nil {
		return result.Result, nil
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// GetMeeting retrieves meeting details from Cloudflare RealtimeKit
func (c *Client) GetMeeting(ctx context.Context, meetingID string) (*Meeting, error) {
	if !c.IsConfigured() {
		return &Meeting{ID: meetingID, Status: "active"}, nil
	}

	path := fmt.Sprintf("/meetings/%s", meetingID)
	resp, err := c.doRequest(ctx, "GET", path, nil)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	var result Response[Meeting]
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// EndMeeting ends a meeting by updating its status to INACTIVE
func (c *Client) EndMeeting(ctx context.Context, meetingID string) (*Meeting, error) {
	if !c.IsConfigured() {
		return &Meeting{ID: meetingID, Status: "inactive"}, nil
	}

	path := fmt.Sprintf("/meetings/%s", meetingID)
	req := map[string]string{"status": "INACTIVE"}

	resp, err := c.doRequest(ctx, "PATCH", path, req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	var result Response[Meeting]
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// AddParticipant adds a participant to a meeting and returns their auth token
func (c *Client) AddParticipant(ctx context.Context, meetingID string, req AddParticipantRequest) (*Participant, error) {
	if !c.IsConfigured() {
		// Return mock participant with demo token for testing
		return &Participant{
			ID:    fmt.Sprintf("demo-participant-%d", time.Now().UnixNano()),
			Token: "demo-token-not-for-production",
		}, nil
	}

	// DEBUG: Log request being sent to Cloudflare
	reqJSON, _ := json.Marshal(req)
	fmt.Printf("[CLOUDFLARE] AddParticipant request: %s\n", string(reqJSON))

	path := fmt.Sprintf("/meetings/%s/participants", meetingID)
	resp, err := c.doRequest(ctx, "POST", path, req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read raw body first for debugging
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	// DEBUG: Log response from Cloudflare
	fmt.Printf("[CLOUDFLARE] AddParticipant response (status %d): %s\n", resp.StatusCode, string(bodyBytes))

	// Log response for debugging
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result Response[Participant]
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	// Check both Data and Result fields
	if result.Result != nil {
		return result.Result, nil
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// RemoveParticipant removes a participant from a meeting
func (c *Client) RemoveParticipant(ctx context.Context, meetingID, participantID string) error {
	// API-MED-08: Return mock response when not configured
	if !c.IsConfigured() {
		return nil
	}

	path := fmt.Sprintf("/meetings/%s/participants/%s", meetingID, participantID)
	resp, err := c.doRequest(ctx, "DELETE", path, nil)
	if err != nil {
		return fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	var result Response[interface{}]
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return nil
}

// RefreshParticipantToken refreshes a participant's auth token
func (c *Client) RefreshParticipantToken(ctx context.Context, meetingID, participantID string) (*Participant, error) {
	// API-MED-08: Return mock response when not configured
	if !c.IsConfigured() {
		return &Participant{
			ID:    participantID,
			Token: "demo-refreshed-token-not-for-production",
		}, nil
	}

	path := fmt.Sprintf("/meetings/%s/participants/%s/token", meetingID, participantID)
	resp, err := c.doRequest(ctx, "POST", path, nil)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	var result Response[Participant]
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// StartRecording starts recording for a meeting
func (c *Client) StartRecording(ctx context.Context, meetingID string, req StartRecordingRequest) (*Recording, error) {
	// API-MED-08: Return mock response when not configured
	if !c.IsConfigured() {
		return &Recording{
			ID:     fmt.Sprintf("demo-recording-%d", time.Now().UnixNano()),
			Status: "recording",
		}, nil
	}

	body := map[string]interface{}{
		"meeting_id": meetingID,
	}
	if req.MaxSeconds > 0 {
		body["max_seconds"] = req.MaxSeconds
	}
	if req.StorageConfig != nil {
		body["storage_config"] = req.StorageConfig
	}
	resp, err := c.doRequest(ctx, "POST", "/recordings", body)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read raw body for better error reporting
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result Response[Recording]
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error (errors=%v, messages=%v): raw=%s", result.Errors, result.Messages, string(bodyBytes))
	}

	return &result.Data, nil
}

// StopRecording stops an active recording
func (c *Client) StopRecording(ctx context.Context, recordingID string) (*Recording, error) {
	// API-MED-08: Return mock response when not configured
	if !c.IsConfigured() {
		return &Recording{
			ID:     recordingID,
			Status: "stopped",
		}, nil
	}

	path := fmt.Sprintf("/recordings/%s", recordingID)
	req := map[string]string{"action": "stop"}

	resp, err := c.doRequest(ctx, "PUT", path, req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	var result Response[Recording]
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// GetRecording retrieves recording details
func (c *Client) GetRecording(ctx context.Context, recordingID string) (*Recording, error) {
	// API-MED-08: Return mock response when not configured
	if !c.IsConfigured() {
		return &Recording{
			ID:     recordingID,
			Status: "ready",
		}, nil
	}

	path := fmt.Sprintf("/recordings/%s", recordingID)
	resp, err := c.doRequest(ctx, "GET", path, nil)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	var result Response[Recording]
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// KickAllParticipants ends an active session by kicking all participants
func (c *Client) KickAllParticipants(ctx context.Context, meetingID string) error {
	// API-MED-08: Return mock response when not configured
	if !c.IsConfigured() {
		return nil
	}

	path := fmt.Sprintf("/meetings/%s/active-session/kick-all", meetingID)
	resp, err := c.doRequest(ctx, "POST", path, nil)
	if err != nil {
		return fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	var result Response[interface{}]
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return nil
}

// GetActiveRecording retrieves the active recording for a meeting
func (c *Client) GetActiveRecording(ctx context.Context, meetingID string) (*Recording, error) {
	// API-MED-08: Return mock response when not configured
	if !c.IsConfigured() {
		return nil, fmt.Errorf("no active recording (mock mode)")
	}

	path := fmt.Sprintf("/recordings/active-recording/%s", meetingID)
	resp, err := c.doRequest(ctx, "GET", path, nil)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	var result Response[Recording]
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// RecordingsListResponse is the response from Cloudflare's list recordings endpoint
type RecordingsListResponse struct {
	Success    bool        `json:"success"`
	Errors     []APIError  `json:"errors,omitempty"`
	Messages   []string    `json:"messages,omitempty"`
	Result     []Recording `json:"result,omitempty"`
	ResultInfo *struct {
		Page       int `json:"page"`
		PerPage    int `json:"per_page"`
		TotalPages int `json:"total_pages"`
		Count      int `json:"count"`
		Total      int `json:"total_count"`
	} `json:"result_info,omitempty"`
}

// ListRecordingsByMeeting retrieves all recordings for a meeting
func (c *Client) ListRecordingsByMeeting(ctx context.Context, meetingID string) ([]Recording, error) {
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare not configured")
	}

	// Try to get active recording first
	activeRec, err := c.GetActiveRecording(ctx, meetingID)
	if err == nil && activeRec != nil {
		return []Recording{*activeRec}, nil
	}

	// Try listing all recordings with meeting_id filter
	path := fmt.Sprintf("/recordings?meeting_id=%s", meetingID)
	resp, err := c.doRequest(ctx, "GET", path, nil)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		// No recordings found - return empty list
		return []Recording{}, nil
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result RecordingsListResponse
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w (body: %.500s)", err, string(bodyBytes))
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return result.Result, nil
}

// CreateWebhook registers a webhook endpoint with Cloudflare RealtimeKit
func (c *Client) CreateWebhook(ctx context.Context, req CreateWebhookRequest) (*Webhook, error) {
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare not configured")
	}

	resp, err := c.doRequest(ctx, "POST", "/webhooks", req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result Response[Webhook]
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if result.Result != nil {
		return result.Result, nil
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// GetWebhook retrieves a webhook by ID
func (c *Client) GetWebhook(ctx context.Context, webhookID string) (*Webhook, error) {
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare not configured")
	}

	path := fmt.Sprintf("/webhooks/%s", webhookID)
	resp, err := c.doRequest(ctx, "GET", path, nil)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("webhook not found: %s", webhookID)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result Response[Webhook]
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if result.Result != nil {
		return result.Result, nil
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}

// ListWebhooks lists all webhooks for the app
func (c *Client) ListWebhooks(ctx context.Context) ([]Webhook, error) {
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare not configured")
	}

	resp, err := c.doRequest(ctx, "GET", "/webhooks", nil)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result WebhooksListResponse
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return result.Result, nil
}

// DeleteWebhook removes a webhook
func (c *Client) DeleteWebhook(ctx context.Context, webhookID string) error {
	if !c.IsConfigured() {
		return fmt.Errorf("cloudflare not configured")
	}

	path := fmt.Sprintf("/webhooks/%s", webhookID)
	resp, err := c.doRequest(ctx, "DELETE", path, nil)
	if err != nil {
		return fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

// UpdateWebhook updates webhook configuration
func (c *Client) UpdateWebhook(ctx context.Context, webhookID string, req UpdateWebhookRequest) (*Webhook, error) {
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare not configured")
	}

	path := fmt.Sprintf("/webhooks/%s", webhookID)
	resp, err := c.doRequest(ctx, "PATCH", path, req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("cloudflare API error (status %d): %s", resp.StatusCode, string(bodyBytes))
	}

	var result Response[Webhook]
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	if result.Result != nil {
		return result.Result, nil
	}

	if !result.Success {
		return nil, fmt.Errorf("cloudflare error: %v", result.Errors)
	}

	return &result.Data, nil
}
