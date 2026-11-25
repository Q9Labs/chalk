package chalksfu

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// ready reads the node's readiness: its packet budget and the part live Episodes
// reserve. A draining node answers 503 with its state, which is a ready result
// with Draining set. Any other reply but 200 is not ready.
func (a *Adapter) ready(ctx context.Context) (protocol.ReadyResponse, error) {
	var ready protocol.ReadyResponse
	status, err := a.readReady(ctx, &ready)
	if err != nil {
		return protocol.ReadyResponse{}, err
	}
	if status == http.StatusServiceUnavailable && !ready.Draining {
		return protocol.ReadyResponse{}, fmt.Errorf("readiness status %d", status)
	}
	return ready, nil
}

func (a *Adapter) readReady(ctx context.Context, out any) (int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, a.base.JoinPath(protocol.RouteReady).String(), nil)
	if err != nil {
		return 0, err
	}
	request.Header.Set("Accept", "application/json")
	reply, err := a.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer reply.Body.Close()
	if reply.StatusCode != http.StatusOK && reply.StatusCode != http.StatusServiceUnavailable {
		return reply.StatusCode, fmt.Errorf("readiness status %d", reply.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(reply.Body, maxResponseBytes)).Decode(out); err != nil {
		return reply.StatusCode, fmt.Errorf("decode readiness (status %d): %w", reply.StatusCode, err)
	}
	return reply.StatusCode, nil
}
