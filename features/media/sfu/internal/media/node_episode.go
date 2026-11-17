package media

import "github.com/q9labs/chalk/features/media/sfu/protocol"

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
	return protocol.EndEpisodeResponse{Closed: len(ended), Sessions: n.outcomesOf(key)}
}
