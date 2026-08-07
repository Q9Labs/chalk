package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/episodediagnostics"
)

type apiClient struct {
	baseURL string
	client  *http.Client
}

type apiError struct {
	Status int
	Code   string
}

func (e *apiError) Error() string {
	code := safeErrorCode(e.Code)
	if code == "" {
		return fmt.Sprintf("diagnostics API returned HTTP %d", e.Status)
	}
	return fmt.Sprintf("diagnostics API returned HTTP %d (%s)", e.Status, code)
}

type appendResponse struct {
	DiagnosticReference string           `json:"diagnosticReference"`
	CommittedCursor     int64            `json:"committedCursor"`
	Accepted            []appendReceipt  `json:"accepted"`
	Duplicates          []appendReceipt  `json:"duplicates"`
	Conflicts           []appendConflict `json:"conflicts"`
}

type appendReceipt struct {
	EventID string `json:"eventId"`
	Cursor  int64  `json:"cursor"`
}

type appendConflict struct {
	EventID string `json:"eventId"`
	Code    string `json:"code"`
}

type pageResponse struct {
	Events     []episodediagnostics.AcceptedDiagnosticEvent `json:"events"`
	NextCursor *int64                                       `json:"nextCursor"`
	HasMore    bool                                         `json:"hasMore"`
	Committed  int64                                        `json:"committedCursor"`
	Projected  int64                                        `json:"projectedCursor"`
}

type snapshotResponse struct {
	Projected int64 `json:"projectedCursor"`
	Committed int64 `json:"committedCursor"`
}

type streamResult struct {
	ControlSeen bool
	Deltas      int64
	Gaps        int64
	LostCursors int64
	LastCursor  int64
	CloseCursor int64
}

func newAPIClient(base string) (*apiClient, error) {
	parsed, err := url.Parse(base)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("base-url must be an absolute URL")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.User = nil
	return &apiClient{baseURL: strings.TrimRight(parsed.String(), "/"), client: &http.Client{Timeout: 35 * time.Second}}, nil
}

func (c *apiClient) append(ctx context.Context, token string, request episodediagnostics.AppendDiagnosticEventsRequest) (appendResponse, time.Duration, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return appendResponse{}, 0, err
	}
	start := time.Now()
	response, err := c.do(ctx, http.MethodPost, "/_internal/episode-diagnostic-events", "", token, "application/json", bytes.NewReader(body))
	latency := time.Since(start)
	if err != nil {
		return appendResponse{}, latency, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return appendResponse{}, latency, decodeAPIError(response)
	}
	var result appendResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return appendResponse{}, latency, fmt.Errorf("decode append response: %w", err)
	}
	return result, latency, nil
}

func (c *apiClient) snapshot(ctx context.Context, reference, token string) (snapshotResponse, time.Duration, error) {
	start := time.Now()
	response, err := c.do(ctx, http.MethodGet, referencePath(reference), "", token, "application/json", nil)
	latency := time.Since(start)
	if err != nil {
		return snapshotResponse{}, latency, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return snapshotResponse{}, latency, decodeAPIError(response)
	}
	var result snapshotResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return snapshotResponse{}, latency, fmt.Errorf("decode snapshot response: %w", err)
	}
	return result, latency, nil
}

func (c *apiClient) pageEvents(ctx context.Context, reference, token string, after *int64, limit int) (pageResponse, time.Duration, error) {
	path := referencePath(reference) + "/events?limit=" + strconv.Itoa(limit)
	if after != nil {
		path += "&after=" + strconv.FormatInt(*after, 10)
	}
	start := time.Now()
	response, err := c.do(ctx, http.MethodGet, path, "", token, "application/json", nil)
	latency := time.Since(start)
	if err != nil {
		return pageResponse{}, latency, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return pageResponse{}, latency, decodeAPIError(response)
	}
	var result pageResponse
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		return pageResponse{}, latency, fmt.Errorf("decode event page: %w", err)
	}
	return result, latency, nil
}

func (c *apiClient) retentionProbe(ctx context.Context, probeURL, token string) (time.Duration, error) {
	start := time.Now()
	probeToken := token
	if strings.HasPrefix(probeURL, "http://") || strings.HasPrefix(probeURL, "https://") {
		parsed, parseErr := url.Parse(probeURL)
		base, baseErr := url.Parse(c.baseURL)
		if parseErr != nil || baseErr != nil || !strings.EqualFold(parsed.Scheme, base.Scheme) || !strings.EqualFold(parsed.Host, base.Host) {
			probeToken = ""
		}
	}
	response, err := c.do(ctx, http.MethodGet, probeURL, "", probeToken, "application/json", nil)
	latency := time.Since(start)
	if err != nil {
		return latency, err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return latency, decodeAPIError(response)
	}
	return latency, nil
}

func (c *apiClient) stream(ctx context.Context, reference, token string, after int64) (streamResult, time.Duration, error) {
	path := referencePath(reference) + "/stream?after=" + strconv.FormatInt(after, 10)
	start := time.Now()
	response, err := c.doWithHeaders(ctx, http.MethodGet, path, "text/event-stream", token, "text/event-stream", nil, map[string]string{"Last-Event-ID": strconv.FormatInt(after, 10)})
	latency := time.Since(start)
	if err != nil {
		return streamResult{}, latency, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return streamResult{}, latency, decodeAPIError(response)
	}
	result, err := readSSE(ctx, response.Body, after)
	return result, latency, err
}

func (c *apiClient) do(ctx context.Context, method, path, accept, token, contentType string, body io.Reader) (*http.Response, error) {
	return c.doWithHeaders(ctx, method, path, accept, token, contentType, body, nil)
}

func (c *apiClient) doWithHeaders(ctx context.Context, method, path, accept, token, contentType string, body io.Reader, extra map[string]string) (*http.Response, error) {
	requestURL := path
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		requestURL = path
	} else {
		requestURL = c.baseURL + "/" + strings.TrimLeft(path, "/")
	}
	request, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return nil, err
	}
	if accept != "" {
		request.Header.Set("Accept", accept)
	}
	if contentType != "" && body != nil {
		request.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range extra {
		request.Header.Set(key, value)
	}
	response, err := c.client.Do(request)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, context.Canceled
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, context.DeadlineExceeded
		}
		return nil, errors.New("diagnostics API request failed")
	}
	return response, nil
}

func decodeAPIError(response *http.Response) error {
	var body struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&body)
	return &apiError{Status: response.StatusCode, Code: safeErrorCode(body.Code)}
}

func safeErrorCode(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 64 {
		return ""
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '.' && character != '_' && character != '-' {
			return ""
		}
	}
	return value
}

func referencePath(reference string) string {
	return "/_internal/episode-diagnostics/" + url.PathEscape(reference)
}
