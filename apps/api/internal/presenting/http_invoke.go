package presenting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// HTTPInvoker is the development implementation of the renderer invocation
// port. The renderer process exposes the same asynchronous jobId shape as the
// Lambda event and then claims through the real control API.
type HTTPInvoker struct {
	endpoint string
	client   *http.Client
}

func NewHTTPInvoker(endpoint string) HTTPInvoker {
	return HTTPInvoker{endpoint: strings.TrimSpace(endpoint), client: &http.Client{Timeout: 5 * time.Second}}
}

func (i HTTPInvoker) Invoke(ctx context.Context, input InvokeInput) error {
	if i.endpoint == "" {
		return fmt.Errorf("missing presenting renderer endpoint")
	}
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, i.endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	response, err := i.client.Do(request)
	if err != nil {
		return fmt.Errorf("invoke local presenting renderer: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("local presenting renderer invocation returned status %d", response.StatusCode)
	}
	return nil
}
