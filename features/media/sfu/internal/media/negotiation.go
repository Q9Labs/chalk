package media

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
)

// negotiationStep is one step of an offer and answer exchange. The slug is what the trail exports;
// the text is for the error the API reads.
type negotiationStep struct{ slug, text string }

var (
	stepOfferTracks      = negotiationStep{"offer_tracks", "offer the tracks"}
	stepGatherICE        = negotiationStep{"gather_ice", "gather ICE candidates"}
	stepReadOffer        = negotiationStep{"read_offer", "read the offer"}
	stepApplyOffer       = negotiationStep{"apply_offer", "apply the offer"}
	stepAnswerOffer      = negotiationStep{"answer_offer", "answer the offer"}
	stepApplyAnswer      = negotiationStep{"apply_answer", "apply the answer"}
	stepApplyCloseOffer  = negotiationStep{"apply_close_offer", "apply the close offer"}
	stepAnswerCloseOffer = negotiationStep{"answer_close_offer", "answer the close offer"}
)

var errGatherTimeout = errors.New("ICE gathering timed out")

// failNegotiation closes the session: after a failed step its peer connection
// cannot return to a stable state, and the client replaces the connection. The journal keeps the
// error text. The trail carries the step and a reason from a closed set, with the request's trace.
func (s *Session) failNegotiation(step negotiationStep, cause error) error {
	s.node.log.Warn("negotiation failed", "connection_id", s.id, "step", step.text, "error", cause)
	s.trail(slog.LevelWarn, EventNegotiationFailed, "step", step.slug, "reason", negotiationReason(cause))
	s.CloseFor(CloseNegotiationFailed)
	return fmt.Errorf("%w: %s: %w", ErrNegotiationFailed, step.text, cause)
}

func negotiationReason(cause error) string {
	switch {
	case errors.Is(cause, context.DeadlineExceeded), errors.Is(cause, errGatherTimeout):
		return "timeout"
	case errors.Is(cause, context.Canceled):
		return "canceled"
	}
	return "rejected"
}
