package recorderworker

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/observability"
	"go.opentelemetry.io/otel/propagation"
)

func (c *ControlPlaneClient) do(ctx context.Context, method, path string, payload any, responseLimit int) ([]byte, int, error) {
	return c.doRequest(ctx, method, path, payload, responseLimit, false)
}

// Only replay-safe Render finishing calls can recover an interrupted success body.
func (c *ControlPlaneClient) doRenderFinish(ctx context.Context, path string, payload any) ([]byte, int, error) {
	return c.doRequest(ctx, http.MethodPost, path, payload, ControlPlaneResponseLimit, true)
}

func (c *ControlPlaneClient) doRequest(ctx context.Context, method, path string, payload any, responseLimit int, retryResponseRead bool) ([]byte, int, error) {
	if c == nil || c.client == nil || c.baseURL == nil {
		return nil, 0, ErrInvalidControlPlaneClient
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, ProtocolError{Err: err}
	}
	if len(body) > ControlPlaneRequestLimit {
		clear(body)
		return nil, 0, ErrControlPlaneProtocol
	}
	defer clear(body)
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + path
	endpoint.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, 0, ProtocolError{Err: err}
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	if journeyID, ok := observability.JourneyIDFromContext(ctx); ok {
		request.Header.Set("X-Chalk-Journey-ID", journeyID.String())
	}
	propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(request.Header))
	if sessionID, ok := observability.SessionIDFromContext(ctx); ok {
		// Only validated correlation data crosses this boundary; baggage properties
		// and unknown members can contain private caller-supplied text.
		request.Header.Set("baggage", observability.SessionIDKey+"="+sessionID)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return nil, 0, TransportError{Err: err}
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, int64(responseLimit)))
		return nil, response.StatusCode, withAPIErrorCode(classifyHTTPError(response.StatusCode), body)
	}
	data, readErr := readBounded(response.Body, responseLimit)
	if readErr != nil {
		if retryResponseRead && !errors.Is(readErr, errResponseTooLarge) {
			return nil, response.StatusCode, TransportError{Err: readErr}
		}
		return nil, response.StatusCode, ProtocolError{Err: readErr}
	}
	return data, response.StatusCode, nil
}

func classifyHTTPError(status int) error {
	if status == http.StatusTooManyRequests || status >= http.StatusInternalServerError {
		return HTTPError{Status: status, Retryable: true}
	}
	if status == http.StatusConflict || status == http.StatusPreconditionFailed {
		return HTTPError{Status: status, Fenced: true}
	}
	return HTTPError{Status: status, Terminal: true}
}

var apiErrorCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

// withAPIErrorCode attaches the API error code so a terminal failure names why the control plane refused.
// Messages are not kept because they can carry request detail.
func withAPIErrorCode(err error, body []byte) error {
	var httpErr HTTPError
	if !errors.As(err, &httpErr) {
		return err
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && apiErrorCodePattern.MatchString(envelope.Error.Code) {
		httpErr.Code = envelope.Error.Code
	}
	return httpErr
}

func decodeBoundedJSON(data []byte, destination any, limit int) error {
	if len(data) > limit {
		return errors.New("response payload is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON")
		}
		return err
	}
	return nil
}

var errResponseTooLarge = errors.New("response payload is too large")

func readBounded(reader io.Reader, limit int) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if len(data) > limit {
		return nil, errResponseTooLarge
	}
	if err != nil {
		return nil, err
	}
	return data, nil
}

func durationSeconds(value time.Duration) (int, error) {
	if value == 0 {
		return 0, nil
	}
	if value < 0 || value%time.Second != 0 || value/time.Second > time.Duration(int(^uint(0)>>1)) {
		return 0, errors.New("duration must be a positive whole number of seconds")
	}
	return int(value / time.Second), nil
}

func decodeHex(value string, exactLength int) ([]byte, error) {
	decoded, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || (exactLength >= 0 && len(decoded) != exactLength) || len(decoded) > 1<<20 {
		return nil, errors.New("invalid hexadecimal value")
	}
	return decoded, nil
}

func parseRequiredTime(value string) (time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, errors.New("timestamp is absent")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}

func stringPointer(value string) *string { return &value }
