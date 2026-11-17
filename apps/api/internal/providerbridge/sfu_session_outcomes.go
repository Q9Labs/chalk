package providerbridge

import (
	"context"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// SessionOutcomes stores how an Episode's Participant sessions ended on the media node, with the
// Participants, for as long as the Participants are kept. Recording the same outcome again changes nothing.
type SessionOutcomes interface {
	Record(ctx context.Context, tenantID, episodeID utilities.ID, outcomes []mediaplane.SessionOutcome) error
}

// WithSessionOutcomes makes ending an Episode on a Chalk node store how its sessions ended. The end
// fails, and so is retried, when they cannot be stored: the node keeps its outcomes for a day, so the
// retry gets them again. Call it after WithChalkSFU.
func (e SFUExecutor) WithSessionOutcomes(outcomes SessionOutcomes) SFUExecutor {
	nodes := e.chalk
	if nodes == nil {
		return e
	}
	e.chalk = func(node string, generation int64) (ChalkNode, error) {
		chalk, err := nodes(node, generation)
		if err != nil {
			return nil, err
		}
		return outcomeRecordingNode{ChalkNode: chalk, outcomes: outcomes}, nil
	}
	return e
}

// outcomeRecordingNode stores the outcomes its node returns when an Episode ends.
type outcomeRecordingNode struct {
	ChalkNode
	outcomes SessionOutcomes
}

func (n outcomeRecordingNode) EndEpisodeSessions(ctx context.Context, input mediaplane.EndEpisodeInput) ([]mediaplane.SessionOutcome, error) {
	ended, err := n.ChalkNode.EndEpisodeSessions(ctx, input)
	if err != nil || len(ended) == 0 {
		return ended, err
	}
	tenantID, tenantErr := utilities.ParseID(input.TenantID)
	episodeID, episodeErr := utilities.ParseID(input.EpisodeRef)
	if tenantErr != nil || episodeErr != nil {
		return ended, fmt.Errorf("save how the sessions of Episode %q ended: the Episode is not named by an id", input.EpisodeRef)
	}
	if err := n.outcomes.Record(ctx, tenantID, episodeID, ended); err != nil {
		return ended, err
	}
	return ended, nil
}
