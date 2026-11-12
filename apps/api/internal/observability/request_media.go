package observability

import (
	"context"
	"crypto/sha256"
	"fmt"
	"sync/atomic"

	"go.opentelemetry.io/otel/attribute"
)

// Span attribute names for the media identity of a request. The plane is the provider
// name the media credential carries, as `chalk.media_plane.provider` on adapter spans.
const (
	EpisodeIDKey       = "episode.id"
	ParticipantHashKey = "participant.id_hash"
	MediaPlaneKey      = "chalk.media_plane.provider"
)

type requestMediaKey struct{}

// requestMedia is what a verified media credential says a request acts for.
type requestMedia struct {
	episodeID       string
	participantHash string
	plane           string
}

// requestMediaHolder is created by RequestMiddleware and filled after the credential is
// verified, deeper in the chain, so the request log line written after the handler returns,
// the failure log written inside it and the request spans all carry the same identity.
type requestMediaHolder struct{ media atomic.Pointer[requestMedia] }

// ParticipantIDHash is the form in which a Participant ID may appear in telemetry.
func ParticipantIDHash(participantID string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(participantID)))
}

// SetRequestMedia records the Episode, the hashed Participant and the media plane a request
// acts for, so its logs and spans join to an Episode. It does nothing outside a request.
func SetRequestMedia(ctx context.Context, episodeID, participantID, plane string) {
	if holder, ok := ctx.Value(requestMediaKey{}).(*requestMediaHolder); ok {
		holder.media.Store(&requestMedia{episodeID: episodeID, participantHash: ParticipantIDHash(participantID), plane: plane})
	}
}

func currentRequestMedia(ctx context.Context) *requestMedia {
	if holder, ok := ctx.Value(requestMediaKey{}).(*requestMediaHolder); ok {
		return holder.media.Load()
	}
	return nil
}

// requestMediaAttrs are the log attributes of the request's media identity, if it has one.
func requestMediaAttrs(ctx context.Context) []any {
	media := currentRequestMedia(ctx)
	if media == nil {
		return nil
	}
	return []any{"episode_id", media.episodeID, "participant_id_hash", media.participantHash, "provider", media.plane}
}

func requestMediaSpanAttributes(ctx context.Context) []attribute.KeyValue {
	media := currentRequestMedia(ctx)
	if media == nil {
		return nil
	}
	return []attribute.KeyValue{attribute.String(EpisodeIDKey, media.episodeID), attribute.String(ParticipantHashKey, media.participantHash), attribute.String(MediaPlaneKey, media.plane)}
}
