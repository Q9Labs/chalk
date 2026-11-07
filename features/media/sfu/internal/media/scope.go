package media

import (
	"fmt"
	"regexp"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// ValidateScope rejects scopes that are empty or carry unexpected characters.
func ValidateScope(scope protocol.Scope) error {
	for name, value := range map[string]string{"tenantId": scope.TenantID, "episodeId": scope.EpisodeID, "participantId": scope.ParticipantID} {
		if !identifierPattern.MatchString(value) {
			return fmt.Errorf("%w: scope.%s must be 1-128 characters of letters, digits, '.', '_', ':' or '-'", ErrInvalidRequest, name)
		}
	}
	if scope.Generation < 1 {
		return fmt.Errorf("%w: scope.generation must be at least 1", ErrInvalidRequest)
	}
	return nil
}

type participantKey struct{ tenant, episode, participant string }

func keyOf(scope protocol.Scope) participantKey {
	return participantKey{scope.TenantID, scope.EpisodeID, scope.ParticipantID}
}

func sameEpisode(a, b protocol.Scope) bool {
	return a.TenantID == b.TenantID && a.EpisodeID == b.EpisodeID
}
