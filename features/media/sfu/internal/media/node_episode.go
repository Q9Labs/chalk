package media

import (
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// closeSettle bounds how long EndEpisode waits for closes already under way, because a session
// that is closing on its own has left the Episode's list but has not yet recorded its outcome.
const closeSettle = 2 * time.Second


// EndEpisode closes every session of the Tenant's Episode and reports how many it closed. The
// close lines carry the trace of the request that ended it.
func (n *Node) EndEpisode(tenantID, episodeID string, trace Trace) protocol.EndEpisodeResponse {
	n.mu.Lock()
	key := episodeKey{tenantID, episodeID}
	ended := n.episodes[key].list()
	n.clearHold(key)
	n.mu.Unlock()
	for _, session := range ended {
		session.Note(trace)
		session.CloseFor(CloseEpisodeEnded)
	}
	for deadline := time.Now().Add(closeSettle); n.closing.Load() > 0 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	return protocol.EndEpisodeResponse{Closed: len(ended), Sessions: n.outcomesOf(key)}
}
