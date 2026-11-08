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

// participantKey names one Participant, or one capture. A capture shares no namespace with
// Participants, so a capture named like a Participant neither replaces it nor takes its fence.
type participantKey struct {
	tenant, episode, participant string
	capture                      bool
}

func keyOf(scope protocol.Scope) participantKey {
	return participantKey{tenant: scope.TenantID, episode: scope.EpisodeID, participant: scope.ParticipantID}
}

func captureKeyOf(scope protocol.Scope) participantKey {
	key := keyOf(scope)
	key.capture = true
	return key
}

// sessionKind is what a session is for. A participant publishes and subscribes. A capture only pulls.
type sessionKind uint8

const (
	kindParticipant sessionKind = iota
	kindCapture
)

func kindOf(name string) (sessionKind, error) {
	switch name {
	case protocol.SessionKindParticipant:
		return kindParticipant, nil
	case protocol.SessionKindCapture:
		return kindCapture, nil
	}
	return 0, fmt.Errorf("%w: unknown session kind %q", ErrInvalidRequest, name)
}

func sameEpisode(a, b protocol.Scope) bool {
	return a.TenantID == b.TenantID && a.EpisodeID == b.EpisodeID
}

func sessionKey(scope protocol.Scope, kind sessionKind) participantKey {
	if kind == kindCapture {
		return captureKeyOf(scope)
	}
	return keyOf(scope)
}
