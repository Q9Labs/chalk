package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

type RequestError struct {
	Operation string
	Attempt   int
	Method    string
	Path      string
	Status    int
	Body      string
	TenantID  string
	RoomID    string
	RequestID string
	Err       error
}

func (e *RequestError) Error() string {
	if e == nil {
		return "cloudflare api error"
	}

	attempt := ""
	if e.Attempt > 0 {
		attempt = fmt.Sprintf(" attempt=%d", e.Attempt)
	}

	operation := ""
	if e.Operation != "" {
		operation = fmt.Sprintf(" operation=%s", e.Operation)
	}

	tenantID := ""
	if e.TenantID != "" {
		tenantID = fmt.Sprintf(" tenant_id=%s", e.TenantID)
	}

	roomID := ""
	if e.RoomID != "" {
		roomID = fmt.Sprintf(" room_id=%s", e.RoomID)
	}

	requestID := ""
	if e.RequestID != "" {
		requestID = fmt.Sprintf(" request_id=%s", e.RequestID)
	}

	if e.Err != nil {
		return fmt.Sprintf("cloudflare %s %s failed:%s%s status=%d%s%s%s body=%s: %v", e.Method, e.Path, operation, attempt, e.Status, tenantID, roomID, requestID, e.Body, e.Err)
	}
	return fmt.Sprintf("cloudflare %s %s failed:%s%s status=%d%s%s%s body=%s", e.Method, e.Path, operation, attempt, e.Status, tenantID, roomID, requestID, e.Body)
}

func (e *RequestError) Unwrap() error {
	return e.Err
}

func newAPIError(operation, method, path string, status int, body []byte, err error) *RequestError {
	return &RequestError{
		Operation: operation,
		Method:    method,
		Path:      path,
		Status:    status,
		Body:      string(body),
		Err:       err,
	}
}

const (
	createMeetingOperation  = "create meeting"
	createMeetingMaxRetries = 3

	addParticipantOperation  = "add participant"
	addParticipantMaxRetries = 3

	createMeetingBaseWait  = 120 * time.Millisecond
	createMeetingMaxWait   = 500 * time.Millisecond
	createMeetingMaxJitter = 40 * time.Millisecond

	addParticipantBaseWait  = 75 * time.Millisecond
	addParticipantMaxWait   = 220 * time.Millisecond
	addParticipantMaxJitter = 25 * time.Millisecond

	addParticipantAttemptTimeout = 3 * time.Second
	addParticipantOverallTimeout = 8 * time.Second
)

type observabilityContext struct {
	tenantID  string
	roomID    string
	requestID string
}

type observabilityContextKey string

const (
	tenantIDContextKey  observabilityContextKey = "chalk.cloudflare.tenant_id"
	roomIDContextKey    observabilityContextKey = "chalk.cloudflare.room_id"
	requestIDContextKey observabilityContextKey = "chalk.cloudflare.request_id"
)

// WithObservabilityContext adds optional request correlation fields for Cloudflare operations.
func WithObservabilityContext(ctx context.Context, tenantID, roomID, requestID string) context.Context {
	if tenantID != "" {
		ctx = context.WithValue(ctx, tenantIDContextKey, tenantID)
	}
	if roomID != "" {
		ctx = context.WithValue(ctx, roomIDContextKey, roomID)
	}
	if requestID != "" {
		ctx = context.WithValue(ctx, requestIDContextKey, requestID)
	}
	return ctx
}

func contextValueString(ctx context.Context, key any) string {
	value := ctx.Value(key)
	if value == nil {
		return ""
	}
	if str, ok := value.(string); ok {
		return str
	}
	if str, ok := value.(fmt.Stringer); ok {
		return str.String()
	}
	return fmt.Sprint(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func getObservabilityContext(ctx context.Context) observabilityContext {
	return observabilityContext{
		tenantID: firstNonEmpty(
			contextValueString(ctx, tenantIDContextKey),
			contextValueString(ctx, "tenant_id"),
			contextValueString(ctx, "chalk.tenant_id"),
		),
		roomID: firstNonEmpty(
			contextValueString(ctx, roomIDContextKey),
			contextValueString(ctx, "room_id"),
			contextValueString(ctx, "chalk.room_id"),
		),
		requestID: firstNonEmpty(
			contextValueString(ctx, requestIDContextKey),
			contextValueString(ctx, "request_id"),
			contextValueString(ctx, "chalk.request_id"),
		),
	}
}

func applyErrorContext(err *RequestError, attempt int, requestContext observabilityContext) *RequestError {
	if err == nil {
		return nil
	}
	err.Attempt = attempt
	err.TenantID = requestContext.tenantID
	err.RoomID = requestContext.roomID
	err.RequestID = requestContext.requestID
	return err
}

func appendRequestContextAttrs(attrs []any, requestContext observabilityContext) []any {
	if requestContext.tenantID != "" {
		attrs = append(attrs, "tenant_id", requestContext.tenantID)
	}
	if requestContext.roomID != "" {
		attrs = append(attrs, "room_id", requestContext.roomID)
	}
	if requestContext.requestID != "" {
		attrs = append(attrs, "request_id", requestContext.requestID)
	}
	return attrs
}

func shouldRetryCloudflareOperation(ctx context.Context, statusCode int, err error) bool {
	if ctx.Err() != nil {
		return false
	}

	switch statusCode {
	case http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	if statusCode >= http.StatusInternalServerError {
		return true
	}

	if err == nil {
		return false
	}

	if errors.Is(err, context.Canceled) {
		return false
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}

	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		if errors.Is(urlErr.Err, context.Canceled) {
			return false
		}
		if urlErr.Timeout() {
			return true
		}
	}

	var netErr net.Error
	if errors.As(err, &netErr) {
		return netErr.Timeout() || netErr.Temporary()
	}

	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

func shouldRetryAddParticipant(ctx context.Context, statusCode int, err error) bool {
	return shouldRetryCloudflareOperation(ctx, statusCode, err)
}

func shouldRetryCreateMeeting(ctx context.Context, statusCode int, err error) bool {
	return shouldRetryCloudflareOperation(ctx, statusCode, err)
}

func cloudflareRetryDelay(attempt int, baseWait, maxWait, maxJitter time.Duration) time.Duration {
	delay := baseWait
	for range max(1, attempt) - 1 {
		delay *= 2
		if delay >= maxWait {
			delay = maxWait
			break
		}
	}

	jitter := time.Duration(rand.Int64N(int64(maxJitter) + 1))
	return delay + jitter
}

func addParticipantRetryDelay(attempt int) time.Duration {
	return cloudflareRetryDelay(attempt, addParticipantBaseWait, addParticipantMaxWait, addParticipantMaxJitter)
}

func createMeetingRetryDelay(attempt int) time.Duration {
	return cloudflareRetryDelay(attempt, createMeetingBaseWait, createMeetingMaxWait, createMeetingMaxJitter)
}

func waitWithContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Client is the Cloudflare RealtimeKit API client
type Client struct {
	httpClient *http.Client
	baseURL    string
	accountID  string
	appID      string
	apiToken   string
	mock       bool
}

// Config holds the configuration for the Cloudflare client
type Config struct {
	AccountID string
	AppID     string
	APIToken  string
	Mock      bool
}

// NewClient creates a new Cloudflare RealtimeKit client
func NewClient(cfg Config) *Client {
	baseTransport := http.DefaultTransport
	transport := otelhttp.NewTransport(baseTransport)
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second, Transport: transport},
		baseURL:    "https://api.cloudflare.com/client/v4",
		accountID:  cfg.AccountID,
		appID:      cfg.AppID,
		apiToken:   cfg.APIToken,
		mock:       cfg.Mock,
	}
}

func (c *Client) IsConfigured() bool {
	if c.mock {
		return true
	}
	return c.accountID != "" && c.appID != "" && c.apiToken != ""
}

func (c *Client) endpoint(path string) string {
	return fmt.Sprintf("%s/accounts/%s/realtime/kit/%s%s",
		c.baseURL, c.accountID, c.appID, path)
}

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
	if c.mock {
		return mockMeeting(req.Title), nil
	}
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare is not configured")
	}

	const path = "/meetings"
	requestContext := getObservabilityContext(ctx)
	totalStart := time.Now()

	for attempt := 1; attempt <= createMeetingMaxRetries; attempt++ {
		attemptStart := time.Now()
		logAttrs := appendRequestContextAttrs([]any{
			"event", "cloudflare.create_meeting",
			"operation", createMeetingOperation,
			"attempt", attempt,
			"method", http.MethodPost,
			"path", path,
			"status_code", 0,
			"title", req.Title,
			"record_on_start", req.RecordOnStart,
			"persist_chat", req.PersistChat,
		}, requestContext)
		slog.DebugContext(ctx, "cloudflare create meeting request", logAttrs...)

		resp, err := c.doRequest(ctx, http.MethodPost, path, req)
		if err != nil {
			attemptElapsed := time.Since(attemptStart)
			apiErr := applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, 0, nil, err), attempt, requestContext)
			logAttrs = append(logAttrs,
				"error", err,
				"attempt_elapsed_ms", attemptElapsed.Milliseconds(),
				"total_elapsed_ms", time.Since(totalStart).Milliseconds(),
			)
			if shouldRetryCreateMeeting(ctx, 0, err) && attempt < createMeetingMaxRetries {
				delay := createMeetingRetryDelay(attempt)
				logAttrs = append(logAttrs, "retry_in_ms", delay.Milliseconds())
				slog.WarnContext(ctx, "cloudflare create meeting request failed, retrying", logAttrs...)
				if waitErr := waitWithContext(ctx, delay); waitErr != nil {
					return nil, applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, 0, nil, waitErr), attempt, requestContext)
				}
				continue
			}
			slog.WarnContext(ctx, "cloudflare create meeting request failed", logAttrs...)
			return nil, apiErr
		}

		bodyBytes, bodyErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if bodyErr != nil {
			attemptElapsed := time.Since(attemptStart)
			apiErr := applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, resp.StatusCode, nil, bodyErr), attempt, requestContext)
			logAttrs = append(logAttrs,
				"status_code", resp.StatusCode,
				"error", bodyErr,
				"attempt_elapsed_ms", attemptElapsed.Milliseconds(),
				"total_elapsed_ms", time.Since(totalStart).Milliseconds(),
			)
			if shouldRetryCreateMeeting(ctx, resp.StatusCode, bodyErr) && attempt < createMeetingMaxRetries {
				delay := createMeetingRetryDelay(attempt)
				logAttrs = append(logAttrs, "retry_in_ms", delay.Milliseconds())
				slog.WarnContext(ctx, "cloudflare create meeting response read failed, retrying", logAttrs...)
				if waitErr := waitWithContext(ctx, delay); waitErr != nil {
					return nil, applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, resp.StatusCode, nil, waitErr), attempt, requestContext)
				}
				continue
			}
			slog.WarnContext(ctx, "cloudflare create meeting response read failed", logAttrs...)
			return nil, apiErr
		}

		attemptElapsed := time.Since(attemptStart)
		logAttrs = append(logAttrs,
			"status_code", resp.StatusCode,
			"attempt_elapsed_ms", attemptElapsed.Milliseconds(),
			"total_elapsed_ms", time.Since(totalStart).Milliseconds(),
		)
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			apiErr := applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, resp.StatusCode, bodyBytes, nil), attempt, requestContext)
			if shouldRetryCreateMeeting(ctx, resp.StatusCode, nil) && attempt < createMeetingMaxRetries {
				delay := createMeetingRetryDelay(attempt)
				logAttrs = append(logAttrs, "retry_in_ms", delay.Milliseconds())
				slog.WarnContext(ctx, "cloudflare create meeting returned retryable status, retrying", logAttrs...)
				if waitErr := waitWithContext(ctx, delay); waitErr != nil {
					return nil, applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, resp.StatusCode, bodyBytes, waitErr), attempt, requestContext)
				}
				continue
			}
			slog.WarnContext(ctx, "cloudflare create meeting failed with non-success status", logAttrs...)
			return nil, apiErr
		}

		var result Response[Meeting]
		if err := json.Unmarshal(bodyBytes, &result); err != nil {
			slog.WarnContext(ctx, "cloudflare create meeting decode failed", append(logAttrs, "error", err)...)
			return nil, applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, resp.StatusCode, bodyBytes, err), attempt, requestContext)
		}

		if result.Result != nil {
			if attempt > 1 {
				slog.InfoContext(ctx, "cloudflare create meeting recovered after retry", logAttrs...)
			} else {
				slog.DebugContext(ctx, "cloudflare create meeting success", logAttrs...)
			}
			return result.Result, nil
		}

		if !result.Success {
			apiErr := applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, resp.StatusCode, bodyBytes, fmt.Errorf("cloudflare error: %v", result.Errors)), attempt, requestContext)
			slog.WarnContext(ctx, "cloudflare create meeting reported unsuccessful response", append(logAttrs, "error", apiErr.Err)...)
			return nil, apiErr
		}

		if attempt > 1 {
			slog.InfoContext(ctx, "cloudflare create meeting recovered after retry", logAttrs...)
		} else {
			slog.DebugContext(ctx, "cloudflare create meeting success", logAttrs...)
		}
		return &result.Data, nil
	}

	return nil, applyErrorContext(newAPIError(createMeetingOperation, http.MethodPost, path, 0, nil, fmt.Errorf("cloudflare create meeting retries exhausted")), createMeetingMaxRetries, requestContext)
}

// GetMeeting retrieves meeting details from Cloudflare RealtimeKit
func (c *Client) GetMeeting(ctx context.Context, meetingID string) (*Meeting, error) {
	if c.mock {
		return &Meeting{
			ID:        meetingID,
			Status:    MeetingStatusActive,
			Title:     "mock-meeting",
			CreatedAt: time.Now(),
			UpdatedAt: time.Now(),
		}, nil
	}
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare is not configured")
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
	if c.mock {
		return &Meeting{
			ID:        meetingID,
			Status:    MeetingStatusInactive,
			Title:     "mock-meeting",
			CreatedAt: time.Now(),
			UpdatedAt: time.Now(),
		}, nil
	}
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare is not configured")

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
	if c.mock {
		return mockParticipant(req), nil
	}
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare is not configured")
	}

	path := fmt.Sprintf("/meetings/%s/participants", meetingID)
	operationCtx, operationCancel := context.WithTimeout(ctx, addParticipantOverallTimeout)
	defer operationCancel()

	requestContext := getObservabilityContext(operationCtx)
	totalStart := time.Now()

	for attempt := 1; attempt <= addParticipantMaxRetries; attempt++ {
		attemptStart := time.Now()
		attemptCtx, attemptCancel := context.WithTimeout(operationCtx, addParticipantAttemptTimeout)
		logAttrs := appendRequestContextAttrs([]any{
			"event", "cloudflare.add_participant",
			"operation", addParticipantOperation,
			"attempt", attempt,
			"method", http.MethodPost,
			"path", path,
			"meeting_id", meetingID,
			"status_code", 0,
			"client_specific_id", req.ClientSpecificID,
			"preset_name", req.PresetName,
			"transcription_enabled", req.TranscriptionEnabled,
			"attempt_timeout_ms", addParticipantAttemptTimeout.Milliseconds(),
			"operation_timeout_ms", addParticipantOverallTimeout.Milliseconds(),
		}, requestContext)
		slog.DebugContext(operationCtx, "cloudflare add participant request", logAttrs...)

		resp, err := c.doRequest(attemptCtx, http.MethodPost, path, req)
		attemptCancel()
		if err != nil {
			attemptElapsed := time.Since(attemptStart)
			apiErr := applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, 0, nil, err), attempt, requestContext)
			logAttrs = append(logAttrs,
				"error", err,
				"attempt_elapsed_ms", attemptElapsed.Milliseconds(),
				"total_elapsed_ms", time.Since(totalStart).Milliseconds(),
			)
			if shouldRetryAddParticipant(operationCtx, 0, err) && attempt < addParticipantMaxRetries {
				delay := addParticipantRetryDelay(attempt)
				logAttrs = append(logAttrs, "retry_in_ms", delay.Milliseconds())
				slog.WarnContext(operationCtx, "cloudflare add participant request failed, retrying", logAttrs...)
				if waitErr := waitWithContext(operationCtx, delay); waitErr != nil {
					return nil, applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, 0, nil, waitErr), attempt, requestContext)
				}
				continue
			}
			slog.WarnContext(operationCtx, "cloudflare add participant request failed", logAttrs...)
			return nil, apiErr
		}

		bodyBytes, bodyErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if bodyErr != nil {
			attemptElapsed := time.Since(attemptStart)
			apiErr := applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, resp.StatusCode, nil, bodyErr), attempt, requestContext)
			logAttrs = append(logAttrs,
				"status_code", resp.StatusCode,
				"error", bodyErr,
				"attempt_elapsed_ms", attemptElapsed.Milliseconds(),
				"total_elapsed_ms", time.Since(totalStart).Milliseconds(),
			)
			if shouldRetryAddParticipant(operationCtx, resp.StatusCode, bodyErr) && attempt < addParticipantMaxRetries {
				delay := addParticipantRetryDelay(attempt)
				logAttrs = append(logAttrs, "retry_in_ms", delay.Milliseconds())
				slog.WarnContext(operationCtx, "cloudflare add participant response read failed, retrying", logAttrs...)
				if waitErr := waitWithContext(operationCtx, delay); waitErr != nil {
					return nil, applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, resp.StatusCode, nil, waitErr), attempt, requestContext)
				}
				continue
			}
			slog.WarnContext(operationCtx, "cloudflare add participant response read failed", logAttrs...)
			return nil, apiErr
		}

		attemptElapsed := time.Since(attemptStart)
		logAttrs = append(logAttrs,
			"status_code", resp.StatusCode,
			"attempt_elapsed_ms", attemptElapsed.Milliseconds(),
			"total_elapsed_ms", time.Since(totalStart).Milliseconds(),
		)
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			apiErr := applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, resp.StatusCode, bodyBytes, nil), attempt, requestContext)
			if shouldRetryAddParticipant(operationCtx, resp.StatusCode, nil) && attempt < addParticipantMaxRetries {
				delay := addParticipantRetryDelay(attempt)
				logAttrs = append(logAttrs, "retry_in_ms", delay.Milliseconds())
				slog.WarnContext(operationCtx, "cloudflare add participant returned retryable status, retrying", logAttrs...)
				if waitErr := waitWithContext(operationCtx, delay); waitErr != nil {
					return nil, applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, resp.StatusCode, bodyBytes, waitErr), attempt, requestContext)
				}
				continue
			}
			slog.WarnContext(operationCtx, "cloudflare add participant failed with non-success status", logAttrs...)
			return nil, apiErr
		}

		var result Response[Participant]
		if err := json.Unmarshal(bodyBytes, &result); err != nil {
			slog.WarnContext(operationCtx, "cloudflare add participant decode failed", append(logAttrs, "error", err)...)
			return nil, applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, resp.StatusCode, bodyBytes, err), attempt, requestContext)
		}

		if result.Result != nil {
			if attempt > 1 {
				slog.InfoContext(operationCtx, "cloudflare add participant recovered after retry", logAttrs...)
			} else {
				slog.DebugContext(operationCtx, "cloudflare add participant success", logAttrs...)
			}
			return result.Result, nil
		}

		if !result.Success {
			apiErr := applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, resp.StatusCode, bodyBytes, fmt.Errorf("cloudflare error: %v", result.Errors)), attempt, requestContext)
			slog.WarnContext(operationCtx, "cloudflare add participant reported unsuccessful response", append(logAttrs, "error", apiErr.Err)...)
			return nil, apiErr
		}

		if attempt > 1 {
			slog.InfoContext(operationCtx, "cloudflare add participant recovered after retry", logAttrs...)
		} else {
			slog.DebugContext(operationCtx, "cloudflare add participant success", logAttrs...)
		}
		return &result.Data, nil
	}

	if operationCtx.Err() != nil {
		return nil, applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, 0, nil, operationCtx.Err()), addParticipantMaxRetries, requestContext)
	}

	return nil, applyErrorContext(newAPIError(addParticipantOperation, http.MethodPost, path, 0, nil, fmt.Errorf("cloudflare add participant retries exhausted")), addParticipantMaxRetries, requestContext)
}

func mockMeeting(title string) *Meeting {
	now := time.Now()
	return &Meeting{
		ID:        uuid.NewString(),
		Title:     title,
		Status:    MeetingStatusActive,
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func mockParticipant(req AddParticipantRequest) *Participant {
	now := time.Now()
	return &Participant{
		ID:               uuid.NewString(),
		Name:             req.Name,
		PresetName:       req.PresetName,
		ClientSpecificID: req.ClientSpecificID,
		Token:            "mock-token-" + uuid.NewString(),
		CreatedAt:        now,
		UpdatedAt:        now,
	}
}

// RemoveParticipant removes a participant from a meeting
func (c *Client) RemoveParticipant(ctx context.Context, meetingID, participantID string) error {
	// API-MED-08: Return mock response when not configured
	if !c.IsConfigured() {
		return fmt.Errorf("cloudflare is not configured")
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
		return nil, fmt.Errorf("cloudflare is not configured")
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
		return nil, fmt.Errorf("cloudflare is not configured")
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
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare is not configured")
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
	if !c.IsConfigured() {
		return nil, fmt.Errorf("cloudflare is not configured")

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
