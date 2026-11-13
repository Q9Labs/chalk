package digitalocean

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recorderfleet"
)

func (a *RecorderFleet) doJSON(ctx context.Context, method, path string, query url.Values, input, output any, expectedStatus int) error {
	select {
	case a.budget.gate <- struct{}{}:
		defer func() { <-a.budget.gate }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := a.budget.wait(ctx); err != nil {
		return err
	}
	return a.sendJSON(ctx, method, path, query, input, output, expectedStatus)
}

func (a *RecorderFleet) sendJSON(ctx context.Context, method, path string, query url.Values, input, output any, expectedStatus int) error {
	endpoint := a.baseURL.ResolveReference(&url.URL{Path: path, RawQuery: query.Encode()})
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return recorderfleet.ErrInvalidConfig
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return recorderfleet.ErrInvalidConfig
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.token)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	a.rateLimitMu.Lock()
	a.rateLimit.Requests++
	a.rateLimitMu.Unlock()
	response, err := a.client.Do(request)
	if err != nil {
		return fmt.Errorf("%w: DigitalOcean request", recorderfleet.ErrProviderUnavailable)
	}
	defer response.Body.Close()
	now := time.Now()
	a.observeResponse(response.Header, now)
	if response.StatusCode == http.StatusTooManyRequests {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		deadline := retryDeadline(response.Header, now)
		if deadline.IsZero() {
			deadline = now.Add(5 * time.Second)
		}
		a.budget.retryAt = maxTime(a.budget.retryAt, deadline)
		return &digitalOceanHTTPStatusError{status: http.StatusTooManyRequests, err: fmt.Errorf("%w: DigitalOcean status 429", &recorderfleet.ProviderRateLimitError{RetryAt: deadline})}
	}
	if remaining := rateLimitNumber(response.Header.Get("RateLimit-Remaining")); remaining != nil && *remaining == 0 {
		a.budget.retryAt = maxTime(a.budget.retryAt, rateLimitReset(response.Header.Get("RateLimit-Reset")))
	}
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		return &digitalOceanHTTPStatusError{status: http.StatusNotFound, err: errNotFound}
	}
	if response.StatusCode != expectedStatus {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: fmt.Errorf("%w: DigitalOcean status %d", recorderfleet.ErrProviderUnavailable, response.StatusCode)}
	}
	if output == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maximumResponseBytes))
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maximumResponseBytes))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("%w: invalid DigitalOcean response", recorderfleet.ErrProviderUnavailable)
	}
	return nil
}

type digitalOceanHTTPStatusError struct {
	status int
	err    error
}

func (err *digitalOceanHTTPStatusError) Error() string { return err.err.Error() }

func (err *digitalOceanHTTPStatusError) Unwrap() error { return err.err }

var errNotFound = errors.New("DigitalOcean resource not found")
