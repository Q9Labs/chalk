package chalksfu

import (
	"context"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// EndEpisodeSessions ends the Episode on the node and returns how each Participant session ended.
// The node reports the same outcomes again if the call repeats, so a retry after a lost answer
// loses none.
func (a *Adapter) EndEpisodeSessions(ctx context.Context, input mediaplane.EndEpisodeInput) ([]mediaplane.SessionOutcome, error) {
	if input.Provider != mediaplane.ProviderChalkSFU {
		return nil, mediaplane.ErrInvalidProvider
	}
	var response protocol.EndEpisodeResponse
	if err := a.call(ctx, protocol.RouteEpisodesEnd, protocol.EndEpisodeRequest{TenantID: input.TenantID, EpisodeID: input.EpisodeRef}, &response); err != nil {
		return nil, err
	}
	outcomes := make([]mediaplane.SessionOutcome, len(response.Sessions))
	for index, session := range response.Sessions {
		outcomes[index] = mediaplane.SessionOutcome{
			ConnectionID: session.SessionID, ParticipantRef: session.ParticipantID, ParticipantVersion: session.Generation,
			Cause: session.Cause, Outcome: session.Outcome, Connected: session.Connected, EndedAt: session.EndedAt,
			LifetimeMs: session.LifetimeMs, ConnectMs: session.ConnectMs, Disconnects: session.Disconnects, OutageMs: session.OutageMs,
		}
	}
	return outcomes, nil
}
