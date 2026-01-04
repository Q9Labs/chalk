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
func (c *Client) CreateMeeting(ctx context.Context, req CreateMeetingRequest) (*Meeting, error) {
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

// EndMeeting ends a meeting by updating its status to ENDED
func (c *Client) EndMeeting(ctx context.Context, meetingID string) (*Meeting, error) {
	path := fmt.Sprintf("/meetings/%s", meetingID)
	req := map[string]string{"status": "ENDED"}

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
	resp, err := c.doRequest(ctx, "POST", "/recordings", map[string]interface{}{
		"meeting_id":       meetingID,
		"recording_config": req.RecordingConfig,
	})
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
	path := fmt.Sprintf("/recordings/%s", recordingID)
	req := map[string]string{"action": "STOP"}

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
