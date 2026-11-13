package chalksfu

import (
	"context"
	"errors"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// errStaleIncarnation means a node answered for another boot than the binding's.
var errStaleIncarnation = errors.New("chalk sfu answered for a replaced node incarnation")

// reserve asks the node to hold room for a whole Episode.
func (a *Adapter) reserve(ctx context.Context, request wireReserveRequest) (wireReserveResponse, error) {
	var reply wireReserveResponse
	if err := a.call(ctx, "/v1/episodes/reserve", request, &reply); err != nil {
		return wireReserveResponse{}, err
	}
	return reply, nil
}

// Bound returns the node's adapter for an Episode placed on the given boot incarnation and
// binding generation. Every create, capture and source control it sends names that generation, so
// the node refuses it once the Episode is retired above it (see Retire). A
// join that the node answers for another incarnation is refused as stale instead of being
// handed to a client: the node restarted and the binding has not caught up yet.
func (a *Adapter) Bound(incarnation string, generation int64) *Adapter {
	bound := *a
	bound.incarnation = incarnation
	bound.allocation = &generation
	return &bound
}

// WithFence returns an adapter that checks a join against the Episode's durable binding once
// the node has created the session. A replica that resolved the binding before another one moved
// it would otherwise create a second live allocation on the node the Episode left, and the
// incarnation check cannot see that, because it compares against the replica's own stale
// binding. When the fence fails, the join closes its session on the node it was issued to and
// returns the fence's error, which the caller retries under the current binding.
func (a *Adapter) WithFence(fence func(context.Context) error) *Adapter {
	fenced := *a
	fenced.fence = fence
	return &fenced
}

// checkIncarnation refuses a node's answer from an incarnation other than the one the
// Episode is bound to.
func (a *Adapter) checkIncarnation(answered string) error {
	if a.incarnation == "" || answered == "" || answered == a.incarnation {
		return nil
	}
	return fmt.Errorf("%w: %w", mediaplane.ErrPlaneUnavailable, errStaleIncarnation)
}
