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
	request, err := sfuWindowRequest(ctx, method, endpoint.String(), input, a.token)
	if err != nil {
		return err
	}
	response, err := a.client.Do(request)
	if err != nil {
		return sfuWindowTransportError(ctx, method, path)
	}
	defer response.Body.Close()
	return a.handleResponse(response, output, expectedStatus)
}

func sfuWindowRequest(ctx context.Context, method, endpoint string, input any, token string) (*http.Request, error) {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return nil, ErrSFUWindowInvalid
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, ErrSFUWindowInvalid
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request, nil
}

func sfuWindowTransportError(ctx context.Context, method, path string) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("%w: %s: %w", ErrSFUWindowProvider, method, ctxErr)
	}
	return fmt.Errorf("%w: %s %s", ErrSFUWindowProvider, method, path)
}

func (a *SFUWindow) handleResponse(response *http.Response, output any, expectedStatus int) error {
	if response.StatusCode == http.StatusTooManyRequests {
		return a.rateLimitResponse(response)
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: errNotFound}
	case response.StatusCode != expectedStatus:
		return &digitalOceanHTTPStatusError{status: response.StatusCode, err: fmt.Errorf("%w: status %d", ErrSFUWindowProvider, response.StatusCode)}
	case output == nil:
		return nil
	}
	return decodeSFUWindowResponse(response.Body, output)
}

func (a *SFUWindow) rateLimitResponse(response *http.Response) error {
	now := time.Now()
	deadline := retryDeadline(response.Header, now)
	if deadline.IsZero() {
		deadline = now.Add(time.Minute)
	}
	retry := &SFUWindowRateLimitError{RetryAt: deadline}
	a.retryAt.Store(retry.RetryAt.UnixNano())
	return &digitalOceanHTTPStatusError{status: response.StatusCode, err: fmt.Errorf("%w: status 429: %w", ErrSFUWindowProvider, retry)}
}

func decodeSFUWindowResponse(body io.Reader, output any) error {
	payload, err := io.ReadAll(io.LimitReader(body, maximumResponseBytes+1))
	if err != nil || len(payload) > maximumResponseBytes {
		return fmt.Errorf("%w: unreadable or oversized response", ErrSFUWindowProvider)
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return fmt.Errorf("%w: invalid response body", ErrSFUWindowProvider)
	}
	return nil
}
