package digitalocean

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

func (a *SFUWindow) nextQuery(next, expectedPath string) (url.Values, error) {
	parsed, err := url.Parse(next)
	if err != nil || parsed.Scheme != a.baseURL.Scheme || parsed.Host != a.baseURL.Host || parsed.User != nil || parsed.Fragment != "" || parsed.Path != expectedPath {
		return nil, fmt.Errorf("%w: unexpected page link", ErrSFUWindowProvider)
	}
	return parsed.Query(), nil
}

// send makes one bounded request: no redirects, no retries, and a body capped at maximumResponseBytes.
func (a *SFUWindow) send(ctx context.Context, method, path string, query url.Values, input, output any, expectedStatus int) error {
	if retryAt := time.Unix(0, a.retryAt.Load()); retryAt.After(time.Now()) {
		return &digitalOceanHTTPStatusError{status: http.StatusTooManyRequests, err: &SFUWindowRateLimitError{RetryAt: retryAt}}
	}
	endpoint := a.baseURL.ResolveReference(&url.URL{Path: path, RawQuery: query.Encode()})
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return ErrSFUWindowInvalid
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return ErrSFUWindowInvalid
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.token)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := a.client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("%w: %s: %w", ErrSFUWindowProvider, method, ctxErr)
		}
		return fmt.Errorf("%w: %s %s", ErrSFUWindowProvider, method, path)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		now := time.Now()
		deadline := retryDeadline(response.Header, now)
		if deadline.IsZero() {
			deadline = now.Add(time.Minute)
		}
		retry := &SFUWindowRateLimitError{RetryAt: deadline}
		a.retryAt.Store(retry.RetryAt.UnixNano())
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: fmt.Errorf("%w: status 429: %w", ErrSFUWindowProvider, retry)}
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: errNotFound}
	case response.StatusCode != expectedStatus:
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: fmt.Errorf("%w: status %d", ErrSFUWindowProvider, response.StatusCode)}
	case output == nil:
		return nil
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil || len(payload) > maximumResponseBytes {
		return fmt.Errorf("%w: unreadable or oversized response", ErrSFUWindowProvider)
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return fmt.Errorf("%w: invalid response body", ErrSFUWindowProvider)
	}
	return nil
}
