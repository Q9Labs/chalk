package main

import (
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/talktime"
)

// newEpisodeTalkTime reads transcripts from object storage, so it is nil, and
// the route answers 503, when transcription is off.
func newEpisodeTalkTime(enabled bool, service episodes.Service, repository talktime.Repository, storage *objectstorage.Service) httpapi.EpisodeTalkTimeService {
	if !enabled || storage == nil {
		return nil
	}
	return talktime.NewService(service, repository, *storage)
}
